import { json, fail, readJson } from '../lib/http.js';
import { CartError, quote, shippingCents } from '../lib/pricing.js';
import { PaypalError, createOrder, newNonce } from '../lib/paypal.js';
import { countPaypalError } from '../lib/alerts.js';
import { placeOrderRoute } from './checkout.js';

export function logPaypalError(c, err, orderId) {
  c.log.error('paypal.error', { op: err.op, upstreamStatus: err.status, upstream: err.upstream, ...(orderId ? { orderId } : {}) });
}

// Maps PayPal failures to responses. Only capture-time 422 is a card decline and doesn't count toward alerts.
// Create-time 422 and all other errors are counted as outages.
export function paypalFailure(c, err, orderId) {
  if (!(err instanceof PaypalError)) throw err;
  logPaypalError(c, err, orderId);
  if (err.op === 'capture' && err.status === 422) return fail(c, 'payment-declined', 422);
  c.waitUntil(countPaypalError(c));
  return fail(c, 'paypal-error', 502);
}

export async function createOrderRoute(req, c) {
  if (c.env.PAYMENT_MODE !== 'paypal') return placeOrderRoute(req, c);
  const body = await readJson(req);
  let q;
  try {
    q = quote(c.data, c.now, body?.items, shippingCents(c.env));
  } catch (err) {
    if (err instanceof CartError) return fail(c, 'invalid-cart', 400);
    throw err;
  }
  if (!q.checkoutReady || q.lines.some(l => l.status !== 'ok')) {
    c.log.warn('order.refused', { code: 'bag-changed' });
    return fail(c, 'bag-changed', 409, { lines: q.lines });
  }
  try {
    const order = await createOrder(c.env, q, newNonce());
    c.log.info('order.created', { orderId: order.id, totalCents: q.totalCents });
    return json({ id: order.id }, 200, { 'Cache-Control': 'no-store' });
  } catch (err) {
    return paypalFailure(c, err);
  }
}
