// Sales live in KV under one key, written by `npm run discount`. KV caches reads at the edge for up to
// SALES_CACHE_TTL seconds, so a new or ended-early sale reaches every shopper within about a minute;
// scheduled start and end times are exact because they're checked against the request clock.
export const SALES_KEY = 'config:sales';
export const SALES_CACHE_TTL = 30;

// A PayPal order priced in the last minutes of a sale can still be captured at that price.
export const SALE_GRACE_MS = 15 * 60 * 1000;

// A read failure prices at full price: checkout then refuses sale-priced orders rather than undercharging silently.
export async function loadSales(env, log) {
  try {
    const raw = await env.ORDERS.get(SALES_KEY, { type: 'text', cacheTtl: SALES_CACHE_TTL });
    if (!raw) return [];
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : [];
  } catch (err) {
    log.error('sales.load_failed', { message: String(err?.message ?? err) });
    return [];
  }
}
