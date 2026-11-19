// 通用 HTTP 响应、Cookie 与客户端 IP 工具

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY'
};

export function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, ...extraHeaders }
  });
}

export function ok(data, status = 200, extraHeaders = {}) {
  return json({ ok: true, data }, status, extraHeaders);
}

export function fail(status, code, message, extraHeaders = {}) {
  return json({ ok: false, error: { code, message } }, status, extraHeaders);
}

export function getCookie(request, name) {
  const raw = request.headers.get('Cookie') || '';
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === name) {
      try {
        return decodeURIComponent(part.slice(idx + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

// 始终带 Secure：生产必为 HTTPS；现代浏览器在 localhost 上也接受 Secure Cookie
export function sessionCookie(token, maxAge) {
  return [
    `session=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    `Max-Age=${maxAge}`
  ].join('; ');
}

export function clearSessionCookie() {
  return ['session=', 'Path=/', 'HttpOnly', 'Secure', 'SameSite=Lax', 'Max-Age=0'].join('; ');
}

export function clientIp(request) {
  const cf = request.headers.get('CF-Connecting-IP');
  if (cf) return cf.trim();
  const forwarded = request.headers.get('X-Forwarded-For');
  if (forwarded) return forwarded.split(',')[0].trim();
  return 'unknown';
}
