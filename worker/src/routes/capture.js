import { json, fail, readJson } from '../lib/http.js';
import { CURRENCY, PaypalError, captureOrder, getOrder, verifyTag } from '../lib/paypal.js';
import { CartError, COUNTED, itemsFromUnit, quote, shippingCents, unitMatchesQuote } from '../lib/pricing.js';
import { buildRecord, findOrder, recordRows, saveOrder } from '../lib/orders.js';
import { alert } from '../lib/alerts.js';
import { paypalFailure } from './orders.js';

const ORDER_ID = /^[A-Za-z0-9]{8,32}$/;

const result = r => ({ id: r.id, status: 'COMPLETED', totalCents: r.totalCents, name: r.payer.firstName, email: r.payer.email });

function refuse(c, orderId, code) {
  const tampering = code === 'tag-mismatch';
  c.log[tampering ? 'error' : 'warn']('capture.refused', { orderId, code });
  if (tampering) c.waitUntil(alert(c, 'capture.tag-mismatch', { subject: 'Possible tampering: unsigned order capture refused', rows: [['Order', orderId]] }));
  return fail(c, 'capture-refused', 409);
}

// Replaced in Task 8 with receipt and owner emails.
export async function afterCapture(c, record, persisted) {}

// Verifies the captured amount, then logs the order and starts the follow-ups. Shared by fresh captures and recoveries.
async function finish(c, orderId, done, q, amount) {
  const paid = done.purchase_units?.[0]?.payments?.captures?.[0]?.amount;
  if (done.status !== 'COMPLETED' || paid?.value !== amount.value || paid?.currency_code !== CURRENCY) {
    c.log.error('capture.refused', { orderId, code: 'amount-mismatch', expected: amount.value, paid: paid?.value ?? null, paypalStatus: done.status });
    c.waitUntil(alert(c, 'capture.amount-mismatch', {
      subject: `Captured amount mismatch on order ${orderId}`,
      rows: [['Order', orderId], ['Expected', amount.value], ['Captured', paid?.value ?? 'none'], ['PayPal status', done.status ?? '']],
      dedupe: false,
    }));
    return fail(c, 'capture-mismatch', 502);
  }

  const record = buildRecord(done, q, c.now);
  let persisted = true;
  try {
    await saveOrder(c.env, record);
  } catch {
    persisted = false;
    c.log.error('order.log_failed', { orderId });
    c.waitUntil(alert(c, 'order.log_failed', { subject: `Paid order ${orderId} was not saved`, rows: recordRows(record), dedupe: false }));
  }
  c.log.info('order.captured', { orderId, totalCents: record.totalCents });
  c.waitUntil(afterCapture(c, record, persisted));
  return json(result(record), 200, { 'Cache-Control': 'no-store' });
}

// POST /api/orders/capture { orderID }
// Captures only orders this server signed, whose contents still re-price to the same amounts and are still buyable.
// An order PayPal already captured (a success the Worker missed) is recorded instead of refused.
export async function captureRoute(req, c) {
  const body = await readJson(req);
  const orderId = body?.orderID;
  if (typeof orderId !== 'string' || !ORDER_ID.test(orderId)) return fail(c, 'invalid-order', 400);

  const existing = await findOrder(c.env, orderId).catch(() => null); // PayPal-Request-Id still prevents a double charge
  if (existing) return json(result(existing), 200, { 'Cache-Control': 'no-store' });

  let order;
  try { order = await getOrder(c.env, orderId); } catch (err) { return paypalFailure(c, err); }

  const unit = order.purchase_units?.[0];
  const amount = unit?.amount;
  const completed = order.status === 'COMPLETED';
  if (order.purchase_units?.length !== 1 || (order.status !== 'APPROVED' && !completed) || amount?.currency_code !== CURRENCY) {
    return refuse(c, orderId, 'not-approved');
  }
  if (!(await verifyTag(c.env, unit.custom_id, amount.value))) return refuse(c, orderId, 'tag-mismatch');

  let q = null;
  const items = itemsFromUnit(unit);
  try { q = items && quote(c.data, c.now, items, shippingCents(c.env)); } catch (err) { if (!(err instanceof CartError)) throw err; }

  if (completed) {
    if (!q) {
      c.log.error('capture.recovered_unpriced', { orderId });
      q = { lines: [], subtotalCents: 0, shippingCents: 0, totalCents: Math.round(Number(amount.value) * 100) };
    }
    c.log.info('order.recovered', { orderId });
    return finish(c, orderId, order, q, amount);
  }

  if (!q) return refuse(c, orderId, 'reprice-mismatch');
  if (q.lines.some(l => !COUNTED.has(l.status))) {
    c.log.warn('capture.refused', { orderId, code: 'bag-changed' });
    return fail(c, 'bag-changed', 409, { lines: q.lines });
  }
  if (!unitMatchesQuote(unit, q)) return refuse(c, orderId, 'reprice-mismatch');

  let done;
  try {
    done = await captureOrder(c.env, orderId);
  } catch (err) {
    if (!(err instanceof PaypalError) || err.status !== 0) return paypalFailure(c, err);
    // The charge may have gone through before the connection dropped; look once more.
    try { done = await getOrder(c.env, orderId); } catch { return paypalFailure(c, err); }
    if (done.status !== 'COMPLETED') return paypalFailure(c, err);
    c.log.info('order.recovered', { orderId });
  }
  return finish(c, orderId, done, q, amount);
}
