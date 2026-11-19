// 密码哈希（PBKDF2-SHA256）与 HMAC 签名会话

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const ITERATIONS = 100000;

// 格式合法但永远校验失败的哈希：用于用户不存在时抵消时序差异
const DUMMY_HASH = 'pbkdf2$100000$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

function toBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function derive(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    key,
    256
  ));
}

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derive(password, salt, ITERATIONS);
  return `pbkdf2$${ITERATIONS}$${toBase64Url(salt)}$${toBase64Url(hash)}`;
}

export async function verifyPassword(password, stored) {
  const parts = (stored || '').split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iterations = Number(parts[1]);
  if (!Number.isSafeInteger(iterations) || iterations < 10000 || iterations > 1000000) return false;

  let salt;
  let expected;
  try {
    salt = fromBase64Url(parts[2]);
    expected = fromBase64Url(parts[3]);
  } catch {
    return false;
  }
  if (salt.length !== 16 || expected.length !== 32) return false;

  const actual = await derive(password, salt, iterations);
  return constantTimeEqual(actual, expected);
}

export async function verifyPasswordSafe(password, storedHashOrNull) {
  return verifyPassword(password, storedHashOrNull || DUMMY_HASH);
}

// 会话登记只存 token 的 SHA-256 摘要，库泄露也无法还原可用 Cookie
export async function hashToken(token) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(token));
  let hex = '';
  for (const byte of new Uint8Array(digest)) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

async function hmacKey(secret) {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

export async function createSession(payload, secret, ttlSeconds) {
  const now = Math.floor(Date.now() / 1000);
  const body = {
    sub: payload.sub,
    u: payload.username,
    iat: now,
    exp: now + ttlSeconds
  };
  const data = toBase64Url(encoder.encode(JSON.stringify(body)));
  const key = await hmacKey(secret);
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(data)));
  return `${data}.${toBase64Url(signature)}`;
}

export async function readSession(token, secret) {
  if (!token || typeof token !== 'string') return null;
  const dot = token.indexOf('.');
  if (dot < 1) return null;

  const data = token.slice(0, dot);
  let signature;
  try {
    signature = fromBase64Url(token.slice(dot + 1));
  } catch {
    return null;
  }
  if (signature.length !== 32) return null;

  let key;
  try {
    key = await hmacKey(secret);
  } catch {
    return null;
  }

  let verified = false;
  try {
    verified = await crypto.subtle.verify('HMAC', key, signature, encoder.encode(data));
  } catch {
    return null;
  }
  if (!verified) return null;

  let body;
  try {
    body = JSON.parse(decoder.decode(fromBase64Url(data)));
  } catch {
    return null;
  }
  if (!body || !Number.isSafeInteger(body.sub) || body.sub <= 0) return null;
  if (!Number.isSafeInteger(body.exp) || body.exp <= Math.floor(Date.now() / 1000)) return null;
  if (typeof body.u !== 'string' || body.u.length > 32) return null;

  return { id: body.sub, username: body.u };
}
