import { json, fail, readJson } from '../lib/http.js';
import { CURRENCY, PaypalError, captureOrder, getOrder, verifyTag } from '../lib/paypal.js';
import { CartError, COUNTED, chargedQuote, itemsFromUnit, quote, shippingCents, unitMatchesQuote } from '../lib/pricing.js';
import { buildRecord, findOrder, recordRows, saveOrder } from '../lib/orders.js';
import { alert } from '../lib/alerts.js';
import { sendOrderEmails } from '../lib/delivery.js';
import { countPaypalError } from '../lib/alerts.js';
import { logPaypalError, paypalFailure } from './orders.js';

const ORDER_ID = /^[A-Za-z0-9]{8,32}$/;

const result = r => ({ id: r.id, status: 'COMPLETED', totalCents: r.totalCents, name: r.payer.firstName, email: r.payer.email });

function refuse(c, orderId, code) {
  const tampering = code === 'tag-mismatch';
  c.log[tampering ? 'error' : 'warn']('capture.refused', { orderId, code });
  if (tampering) c.waitUntil(alert(c, 'capture.tag-mismatch', { subject: 'Possible tampering: unsigned order capture refused', rows: [['Order', orderId]] }));
  return fail(c, 'capture-refused', 409);
}

export function afterCapture(c, record, persisted) {
  return sendOrderEmails(c, record, { persisted });
}

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
  if (record.captureStatus !== 'COMPLETED') {
    c.log.warn('order.payment_pending', { orderId, captureStatus: record.captureStatus });
    c.waitUntil(alert(c, 'order.payment_pending', { subject: `Payment pending on order ${orderId}`, rows: recordRows(record), dedupe: false }));
  }
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
// An order PayPal already captured (a success the Worker missed) is recorded, at the amounts PayPal charged, instead of refused.
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
    if (!q) c.log.error('capture.recovered_unpriced', { orderId });
    c.log.info('order.recovered', { orderId });
    return finish(c, orderId, order, chargedQuote(unit, q), amount);
  }

  if (!q) return refuse(c, orderId, 'reprice-mismatch');
  if (q.lines.some(l => !COUNTED.has(l.status))) {
    c.log.warn('capture.refused', { orderId, code: 'bag-changed' });
    return fail(c, 'bag-changed', 409, { lines: q.lines });
  }
  if (!unitMatchesQuote(unit, q)) return refuse(c, orderId, 'reprice-mismatch');

  const outcome = await capture(c, orderId);
  if (outcome instanceof Response) return outcome;
  return finish(c, orderId, outcome.order, outcome.recovered ? chargedQuote(unit, q) : q, amount);
}

// A 5xx or a dropped connection says nothing about whether PayPal charged.
const unknownOutcome = err => err instanceof PaypalError && (err.status === 0 || err.status >= 500);

const reread = (c, orderId) => getOrder(c.env, orderId).catch(() => null);

// Captures once, and if the outcome is unknown, re-reads the order and retries once (PayPal-Request-Id prevents a double charge).
// Resolves to { order, recovered } for a charge, or an error Response. "Not charged" is only said when PayPal definitely refused.
async function capture(c, orderId) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return { order: await captureOrder(c.env, orderId), recovered: false };
    } catch (err) {
      if (!(err instanceof PaypalError)) throw err;
      const unknown = unknownOutcome(err);
      if (!unknown && attempt === 0) return paypalFailure(c, err, orderId);
      const after = await reread(c, orderId);
      // A definite refusal of the retry is trusted only while PayPal still shows the order unpaid.
      if (!unknown && after?.status === 'APPROVED') return paypalFailure(c, err, orderId);
      logPaypalError(c, err, orderId);
      c.waitUntil(countPaypalError(c));
      if (after?.status === 'COMPLETED') return recovered(c, orderId, after);
      if (!unknown || after?.status !== 'APPROVED') break;
    }
  }
  c.log.error('capture.unknown', { orderId });
  return fail(c, 'capture-unknown', 502);
}

function recovered(c, orderId, order) {
  c.log.info('order.recovered', { orderId });
  return { order, recovered: true };
}
