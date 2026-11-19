// 常量时间比较与 HMAC 签名会话

const encoder = new TextEncoder();
const decoder = new TextDecoder();

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

function constantTimeEqualBytes(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// 字符串常量时间比较：先把两侧哈希成等长摘要再逐字节比较，
// 避免长度差异与首个不同字符位置泄漏时序信息。
async function digestText(text) {
  const buf = await crypto.subtle.digest('SHA-256', encoder.encode(text));
  return new Uint8Array(buf);
}

export async function constantTimeEqualTextSafe(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const [da, db] = await Promise.all([digestText(a), digestText(b)]);
  return constantTimeEqualBytes(da, db);
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
  // 随机标识保证 token 唯一：负载只有秒级时间戳时，同一秒内多次登录会产出
  // 完全相同的 token，导致 sessions 表 token_hash 主键冲突
  const jti = toBase64Url(crypto.getRandomValues(new Uint8Array(12)));
  const body = {
    sub: payload.sub,
    u: payload.username,
    iat: now,
    exp: now + ttlSeconds,
    j: jti
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
