// Fixed-window rate limiter in Deno KV with the interface of Cloudflare's rate limit binding: limit({ key }) → { success }.
// Refused hits write nothing. Every write clash means another hit's count landed, so limit + 2 attempts always settle; if they somehow don't, the hit is refused.

export function kvLimiter(kv, name, { limit, period, now = Date.now }) {
  const ms = period * 1000;
  return {
    async limit({ key }) {
      const k = ['rl', name, String(key), Math.floor(now() / ms)];
      for (let round = 0; round <= limit + 1; round++) {
        const entry = await kv.get(k);
        const count = (entry.value ?? 0) + 1;
        if (count > limit) return { success: false };
        if ((await kv.atomic().check(entry).set(k, count, { expireIn: 2 * ms }).commit()).ok) return { success: true };
      }
      return { success: false };
    },
  };
}
