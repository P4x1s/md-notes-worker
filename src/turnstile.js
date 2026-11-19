// Cloudflare Turnstile 服务端校验：token 单次有效、约 300 秒过期由 siteverify 保证
// 安全降级：SITE_KEY 与 SECRET_KEY 必须同时存在才视为启用，只配一个按未启用处理

// 官方"always passes"测试密钥：本地/CI 环境无外网时跳过 siteverify 调用，
// 语义与官方一致（该密钥仅用于测试，配置到生产等同自担风险）
const OFFICIAL_TEST_SECRET = '1x0000000000000000000000000000000AA';

export function turnstileEnabled(env) {
  return Boolean(env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET_KEY);
}

export async function verifyTurnstileToken(env, token, remoteIp) {
  if (typeof token !== 'string' || !token || token.length > 2048) return false;

  if (env.TURNSTILE_SECRET_KEY === OFFICIAL_TEST_SECRET) {
    return true;
  }

  const body = new URLSearchParams({
    secret: env.TURNSTILE_SECRET_KEY,
    response: token
  });
  if (remoteIp && remoteIp !== 'unknown') body.set('remoteip', remoteIp);

  try {
    // siteverify 端点已从 api.cloudflare.com/client/v4 迁移至 challenges.cloudflare.com
    const response = await fetch(
      'https://challenges.cloudflare.com/turnstile/v0/siteverify',
      { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body }
    );
    if (!response.ok) return false;
    const data = await response.json();
    return data && data.success === true;
  } catch (error) {
    // siteverify 网络异常时拒绝登录（fail-closed），避免验证被绕过
    console.error('turnstile siteverify failed', error);
    return false;
  }
}
