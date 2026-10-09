import { json, fail, readJson } from '../lib/http.js';
import { CartError, quote, shippingCents, statusCounts } from '../lib/pricing.js';

export async function quoteRoute(req, c) {
  const body = await readJson(req);
  try {
    const q = quote(c.data, c.now, body?.items, body?.fulfillmentType === 'pickup' ? 0 : shippingCents(c.env));
    c.log.info('bag.quoted', { statuses: statusCounts(q.lines), totalCents: q.totalCents });
    return json(q, 200, { 'Cache-Control': 'no-store' });
  } catch (err) {
    if (err instanceof CartError) return fail(c, 'invalid-cart', 400);
    throw err;
  }
}
