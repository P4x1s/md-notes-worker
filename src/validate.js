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

// 显示名：仅用于界面展示，放宽字符限制但禁止控制字符与首尾空白
export function validateDisplayName(value) {
  if (typeof value !== 'string') return '显示名必须是字符串';
  const name = value.trim();
  if (name.length < 1 || name.length > 32) return '显示名长度需在 1-32 之间';
  if (/[\u0000-\u001f\u007f]/.test(name)) return '显示名不能包含控制字符';
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
  // 强制 JSON Content-Type：跨站表单/fetch 只能发 text/plain 等简单类型，
  // application/json 会触发 CORS 预检被浏览器拦截，是比 SameSite 更可靠的 CSRF 防线
  const contentType = (request.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
  if (contentType !== 'application/json') {
    throw new HttpError(415, 'unsupported_media_type', '请求必须是 application/json');
  }

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
