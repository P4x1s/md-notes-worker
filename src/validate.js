// 输入校验与安全请求体读取

export const LIMITS = {
  usernameMin: 3,
  usernameMax: 32,
  passwordMin: 8,
  passwordMax: 128,
  titleMax: 200,
  contentMax: 200 * 1024,
  bodyMax: 256 * 1024
};

const USERNAME_RE = /^[A-Za-z0-9_]+$/;

export class HttpError extends Error {
  constructor(status, code, message, headers = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}

export function validateUsername(value) {
  if (typeof value !== 'string') return '用户名必须是字符串';
  const username = value.trim();
  if (username.length < LIMITS.usernameMin || username.length > LIMITS.usernameMax) {
    return `用户名长度需在 ${LIMITS.usernameMin}-${LIMITS.usernameMax} 之间`;
  }
  if (!USERNAME_RE.test(username)) return '用户名只能包含字母、数字和下划线';
  return null;
}

export function validatePassword(value) {
  if (typeof value !== 'string') return '密码必须是字符串';
  if (value.length < LIMITS.passwordMin || value.length > LIMITS.passwordMax) {
    return `密码长度需在 ${LIMITS.passwordMin}-${LIMITS.passwordMax} 之间`;
  }
  return null;
}

export function validateNote(title, content) {
  if (typeof title !== 'string') return '标题必须是字符串';
  if (title.length > LIMITS.titleMax) return `标题不能超过 ${LIMITS.titleMax} 个字符`;
  if (typeof content !== 'string') return '内容必须是字符串';
  const bytes = new TextEncoder().encode(content).length;
  if (bytes > LIMITS.contentMax) return `内容不能超过 ${LIMITS.contentMax / 1024} KB`;
  return null;
}

export function parseId(raw) {
  if (!/^\d{1,10}$/.test(raw || '')) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export async function readJson(request) {
  const declared = Number(request.headers.get('Content-Length') || '0');
  if (declared > LIMITS.bodyMax) {
    throw new HttpError(413, 'payload_too_large', '请求体过大');
  }

  let text;
  try {
    text = await request.text();
  } catch {
    throw new HttpError(400, 'bad_request', '无法读取请求体');
  }
  if (new TextEncoder().encode(text).length > LIMITS.bodyMax) {
    throw new HttpError(413, 'payload_too_large', '请求体过大');
  }

  let data;
  try {
    data = JSON.parse(text || '{}');
  } catch {
    throw new HttpError(400, 'bad_request', '请求体不是合法的 JSON');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new HttpError(400, 'bad_request', '请求体必须是 JSON 对象');
  }
  return data;
}
