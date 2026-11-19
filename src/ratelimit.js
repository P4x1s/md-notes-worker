// 基于 KV 的固定窗口限流（近似计数，适合基础防护；最终一致性意味着不是精确计数）

export async function checkRateLimit(env, identity, action, limit, windowSeconds) {
  if (!env.RATE_LIMIT) return { ok: true, skipped: true };

  const bucket = Math.floor(Date.now() / 1000 / windowSeconds);
  const key = `rl:${action}:${identity}:${bucket}`;
  let count = 0;

  try {
    const raw = await env.RATE_LIMIT.get(key);
    count = raw ? Number(raw) : 0;
    if (!Number.isFinite(count) || count < 0) count = 0;

    if (count >= limit) {
      return { ok: false, retryAfter: windowSeconds };
    }
    await env.RATE_LIMIT.put(key, String(count + 1), { expirationTtl: windowSeconds * 2 });
  } catch (error) {
    // 限流存储故障时放行并记录，避免把登录能力整体锁死
    console.error('rate limit storage error', error);
    return { ok: true, skipped: true };
  }

  return { ok: true, remaining: limit - count - 1 };
}
