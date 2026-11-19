// Cloudflare Worker 入口：API 路由 + 静态资源 + 统一安全响应头

import { ok, fail, getCookie, sessionCookie, clearSessionCookie, clientIp } from './http.js';
import { HttpError, readJson, validateUsername, validatePassword, validateNote, parseId } from './validate.js';
import { createSession, readSession, hashToken, constantTimeEqualTextSafe } from './auth.js';
import { checkRateLimit } from './ratelimit.js';
import { turnstileEnabled, verifyTurnstileToken } from './turnstile.js';
import * as db from './db.js';

const COOKIE_NAME = 'session';
const DEFAULT_SESSION_TTL = 7 * 24 * 3600;
const LOGIN_LIMIT = 10;
const LOGIN_WINDOW = 60;

const BASE_SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    "connect-src 'self'",
    "font-src 'self' data:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'"
  ].join('; ')
};

// Turnstile 启用时放行其脚本与 iframe（CSP 按需拼接，未启用时与原静态头完全一致）
function buildSecurityHeaders(env) {
  if (!turnstileEnabled(env)) return { ...BASE_SECURITY_HEADERS };
  const csp = BASE_SECURITY_HEADERS['Content-Security-Policy']
    .replace("script-src 'self'", "script-src 'self' https://challenges.cloudflare.com")
    .replace("connect-src 'self'", "connect-src 'self' https://challenges.cloudflare.com")
    + "; frame-src https://challenges.cloudflare.com";
  return { ...BASE_SECURITY_HEADERS, 'Content-Security-Policy': csp };
}

function withHeaders(response, env) {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(buildSecurityHeaders(env))) {
    if (!headers.has(name)) headers.set(name, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

function sessionTtl(env) {
  const configured = Number(env.SESSION_TTL_SECONDS);
  return Number.isSafeInteger(configured) && configured >= 3600 && configured <= 30 * 24 * 3600
    ? configured
    : DEFAULT_SESSION_TTL;
}

function requireConfig(env) {
  if (!env.DB) throw new HttpError(500, 'misconfigured', 'D1 数据库未绑定');
  if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 16) {
    throw new HttpError(500, 'misconfigured', 'SESSION_SECRET 未配置或长度不足 16');
  }
  if (!env.ADMIN_USERNAME || !env.ADMIN_PASSWORD) {
    throw new HttpError(500, 'misconfigured', 'ADMIN_USERNAME / ADMIN_PASSWORD 未配置');
  }
}

// 签发会话：签名 Cookie + 服务端登记（摘要入库），使登出可真正吊销
async function issueSession(env, user, ttl) {
  const token = await createSession(
    { sub: user.id, username: user.username },
    env.SESSION_SECRET,
    ttl
  );
  await db.insertSession(env.DB, user.id, await hashToken(token), Date.now() + ttl * 1000);
  return sessionCookie(token, ttl);
}

async function currentUser(request, env) {
  requireConfig(env);
  const token = getCookie(request, COOKIE_NAME);
  const session = await readSession(token, env.SESSION_SECRET);
  if (!session) return null;

  // 签名有效还不够：必须存在未过期的服务端登记记录
  const record = await db.findSession(env.DB, await hashToken(token));
  if (!record || Number(record.user_id) !== session.id || Number(record.expires_at) <= Date.now()) {
    return null;
  }
  return db.findUserById(env.DB, session.id);
}

async function requireUser(request, env) {
  const user = await currentUser(request, env);
  if (!user) return { response: fail(401, 'unauthorized', '请先登录') };
  return { user };
}

// ---------------- 鉴权接口 ----------------

async function handleLogin(request, env) {
  requireConfig(env);

  const limit = await checkRateLimit(env, clientIp(request), 'login', LOGIN_LIMIT, LOGIN_WINDOW);
  if (!limit.ok) {
    return fail(429, 'rate_limited', '尝试次数过多，请稍后再试', { 'Retry-After': String(limit.retryAfter) });
  }

  const body = await readJson(request);

  // 人机验证：启用 Turnstile 时必须携带有效 token（单次使用，失败即拒）
  if (turnstileEnabled(env)) {
    const pass = await verifyTurnstileToken(env, body.turnstileToken, clientIp(request));
    if (!pass) return fail(403, 'turnstile_failed', '人机验证未通过，请刷新验证后重试');
  }

  if (typeof body.username !== 'string' || typeof body.password !== 'string') {
    return fail(400, 'invalid_input', '请输入用户名和密码');
  }
  const inputError = validateUsername(body.username.trim()) || validatePassword(body.password);
  if (inputError) return fail(400, 'invalid_input', inputError);

  // 单用户模式：与 Worker 变量/密钥中的 ADMIN_USERNAME / ADMIN_PASSWORD 比较。
  // 两侧均哈希后常量时间比较，避免时序泄漏匹配进度。
  const [userMatch, passMatch] = await Promise.all([
    constantTimeEqualTextSafe(body.username.trim(), env.ADMIN_USERNAME),
    constantTimeEqualTextSafe(body.password, env.ADMIN_PASSWORD)
  ]);
  if (!userMatch || !passMatch) return fail(401, 'invalid_credentials', '用户名或密码错误');

  const user = await db.getOrCreateUser(env.DB, env.ADMIN_USERNAME);
  const ttl = sessionTtl(env);
  const cookie = await issueSession(env, user, ttl);
  // 顺带清理过期登记，避免 sessions 表无限增长
  try { await db.deleteExpiredSessions(env.DB); } catch (ignore) { /* 不影响登录 */ }
  return ok({
    user: { id: user.id, username: user.username, created_at: user.created_at }
  }, 200, { 'Set-Cookie': cookie });
}

async function handleLogout(request, env) {  const token = getCookie(request, COOKIE_NAME);
  if (token && env.DB) {
    try {
      await db.deleteSession(env.DB, await hashToken(token));
    } catch (error) {
      console.error('session revoke failed', error);
    }
  }
  return ok({ loggedOut: true }, 200, { 'Set-Cookie': clearSessionCookie() });
}

async function handleMe(request, env) {
  const { user, response } = await requireUser(request, env);
  return response || ok({ user });
}

// 登录页配置：告知前端是否启用人机验证及站点密钥（site key 本身是公开信息）
function handleAuthConfig(env) {
  return ok({
    turnstile: turnstileEnabled(env)
      ? { enabled: true, siteKey: env.TURNSTILE_SITE_KEY }
      : { enabled: false }
  });
}

// ---------------- 笔记接口 ----------------

async function handleListNotes(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;
  return ok({ notes: await db.listNotes(env.DB, user.id) });
}

function readNoteInput(body) {
  const title = typeof body.title === 'string' && body.title.trim() ? body.title.trim() : '未命名笔记';
  const content = typeof body.content === 'string' ? body.content : '';
  const inputError = validateNote(title, content);
  return inputError ? { error: inputError } : { title, content };
}

async function handleCreateNote(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const input = readNoteInput(await readJson(request));
  if (input.error) return fail(400, 'invalid_input', input.error);

  const note = await db.insertNote(env.DB, user.id, input.title, input.content);
  return ok({ note }, 201);
}

async function handleGetNote(request, env, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const note = await db.findNote(env.DB, user.id, id);
  return note ? ok({ note }) : fail(404, 'not_found', '笔记不存在');
}

async function handleUpdateNote(request, env, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const input = readNoteInput(await readJson(request));
  if (input.error) return fail(400, 'invalid_input', input.error);

  const note = await db.updateNote(env.DB, user.id, id, input.title, input.content);
  return note ? ok({ note }) : fail(404, 'not_found', '笔记不存在');
}

async function handleDeleteNote(request, env, id) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const removed = await db.removeNote(env.DB, user.id, id);
  return removed ? ok({ deleted: true }) : fail(404, 'not_found', '笔记不存在');
}

// ---------------- 路由 ----------------

async function handleApi(request, env, path) {
  const method = request.method;

  if (path === '/api/auth/login' && method === 'POST') return handleLogin(request, env);
  if (path === '/api/auth/logout' && method === 'POST') return handleLogout(request, env);
  if (path === '/api/auth/me' && method === 'GET') return handleMe(request, env);
  if (path === '/api/auth/config' && method === 'GET') return handleAuthConfig(env);

  if (path === '/api/notes' && method === 'GET') return handleListNotes(request, env);
  if (path === '/api/notes' && method === 'POST') return handleCreateNote(request, env);

  const noteMatch = path.match(/^\/api\/notes\/(\d+)$/);
  if (noteMatch) {
    const id = parseId(noteMatch[1]);
    if (!id) return fail(400, 'invalid_id', '笔记 ID 无效');
    if (method === 'GET') return handleGetNote(request, env, id);
    if (method === 'PUT') return handleUpdateNote(request, env, id);
    if (method === 'DELETE') return handleDeleteNote(request, env, id);
  }

  return fail(404, 'not_found', '接口不存在');
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      let response;

      if (url.pathname.startsWith('/api/')) {
        response = await handleApi(request, env, url.pathname);
      } else if (env.ASSETS) {
        response = await env.ASSETS.fetch(request);
        // SPA 兜底：非文件型 404 请求回退到首页
        if (response.status === 404 && !url.pathname.includes('.')) {
          response = await env.ASSETS.fetch(new Request(new URL('/index.html', url).toString()));
        }
      } else {
        response = fail(404, 'not_found', '页面不存在');
      }

      return withHeaders(response, env);
    } catch (error) {
      if (error instanceof HttpError) {
        return withHeaders(fail(error.status, error.code, error.message, error.headers), env);
      }
      console.error('Unhandled error:', error && error.stack ? error.stack : error);
      return withHeaders(fail(500, 'internal_error', '服务器内部错误'), env);
    }
  }
};
