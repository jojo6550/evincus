import { json, fail, readJson, HttpError } from '../lib/http.js';
import { CartError, quote } from '../lib/pricing.js';
import { parseCheckout, checkoutShipping, directRecord } from '../lib/checkout.js';
import { sendOrderEmails } from '../lib/delivery.js';
import { PICKUP_LOCATIONS, deliveryCountries } from '../../data/fulfillment.js';
import { findOrder } from '../lib/orders.js';

export function checkoutOptions(req, c) {
  return json({ pickupLocations: PICKUP_LOCATIONS, countries: deliveryCountries(c.env), deliveryShippingCents: checkoutShipping(c.env, 'delivery') }, 200, { 'Cache-Control': 'no-store' });
}

export async function placeOrderRoute(req, c) {
  const body = await readJson(req);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body?.checkoutToken ?? '')) throw new HttpError('invalid-order', 400);
  if (c.env.ORDER_LIMIT) {
    const result = await c.env.ORDER_LIMIT.limit({ key: req.headers.get('CF-Connecting-IP') ?? 'unknown' });
    if (!result.success) return fail(c, 'rate-limited', 429);
  }
  const details = parseCheckout(body, c.env);
  if (!Array.isArray(body.items) || !body.items.every(i => i && typeof i === 'object')) return fail(c, 'invalid-cart', 400);
  const bytes = new TextEncoder().encode(JSON.stringify({ items: body.items.map(({ id, color, size, qty }) => ({ id, color, size, qty })), ...details, expectedTotalCents: body.expectedTotalCents }));
  const fingerprint = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
  const id = `EV-${body.checkoutToken.toLowerCase()}`;
  const stub = c.env.ORDER_SUBMISSIONS.get(c.env.ORDER_SUBMISSIONS.idFromName(id));
  const submit = record => stub.fetch('https://submission.internal/', { method: 'POST', body: JSON.stringify({ fingerprint, record }) });
  let response = await submit(null);
  if (response.status === 409) return fail(c, 'checkout-conflict', 409);
  if (!response.ok) throw new Error('Order storage unavailable');
  let { record } = await response.json();
  if (!record) {
    let q;
    try { q = quote(c.data, c.now, body?.items, checkoutShipping(c.env, details.fulfillment.type)); }
    catch (err) { if (err instanceof CartError) return fail(c, 'invalid-cart', 400); throw err; }
    // Never silently accept a changed price or capped quantity.
    if (!q.checkoutReady || q.lines.some(l => l.status !== 'ok') || body.expectedTotalCents !== q.totalCents) return fail(c, 'bag-changed', 409, { lines: q.lines });
    response = await submit(directRecord(id, q, details, c.now));
    if (response.status === 409) return fail(c, 'checkout-conflict', 409);
    if (!response.ok) throw new Error('Order storage unavailable');
    ({ record } = await response.json());
  }
  c.log.info('order.placed', { orderId: id, totalCents: record.totalCents });
  c.waitUntil((async () => {
    const latest = await findOrder(c.env, id);
    await sendOrderEmails(c, latest ?? record, { persisted: true });
  })().catch(err => c.log.error('email.failed', { orderId: id, message: String(err.message) })));
  return json({ id, status: record.status, paymentStatus: record.paymentStatus, name: record.customer.name, email: record.customer.email, fulfillment: record.fulfillment, totalCents: record.totalCents }, 201, { 'Cache-Control': 'no-store' });
}
