import { json, HttpError } from '../lib/http.js';
import { findOrder } from '../lib/orders.js';
import { startPayment, confirmPayment, failAttempt, attemptKey } from '../lib/payments.js';
import { wipayConfig, validTransactionId, verifyHash } from '../lib/wipay.js';
import { alert } from '../lib/alerts.js';

const noStore = { 'Cache-Control': 'no-store' };

// POST /api/orders/:id/pay → { paid: true } | { url }.
export async function payRoute(req, c) {
  return json(await startPayment(c, c.params[0]), 200, noStore);
}

// GET /api/orders/:id/status: what order.html shows. Nothing personal.
export async function orderStatusRoute(req, c) {
  const o = await findOrder(c.env, c.params[0]);
  if (!o) throw new HttpError('unknown-order', 404);
  return json({
    id: o.id, status: o.status, paymentStatus: o.paymentStatus, totalCents: o.totalCents,
    paidAt: o.payment?.paidAt ?? null, transactionId: o.payment?.transactionId ?? null, fulfillmentType: o.fulfillment?.type ?? null,
  }, 200, noStore);
}

const to = (orderId, outcome) => new Response(null, {
  status: 303, headers: { Location: `/order.html?${orderId ? `order=${encodeURIComponent(orderId)}&` : ''}checkout=${outcome}` },
});

// GET /api/payments/wipay/return: WiPay sends the browser here. The query string is untrusted; only a hash over our
// own total marks an order paid. Always a redirect to order.html, never WiPay's raw values or a 500.
export async function wipayReturnRoute(req, c) {
  let orderId = null;
  try {
    const p = new URL(req.url).searchParams;
    const get = k => (p.get(k) ?? '').slice(0, 256);
    const attemptId = get('order_id');
    const attempt = /^[A-Za-z0-9]{16}$/.test(attemptId) && await c.env.ORDERS.get(attemptKey(attemptId), 'json');
    if (!attempt) { c.log.warn('payment.failed', { reason: 'unknown-attempt' }); return to(null, 'failed'); }
    orderId = attempt.orderId;
    const config = wipayConfig(c.env);
    if (!config) { c.log.error('payment.failed', { orderId, attemptId, reason: 'payments-off' }); return to(orderId, 'failed'); }
    if (get('status') !== 'success') {
      await failAttempt(c, attemptId);
      c.log.info('payment.failed', { orderId, attemptId, reason: 'declined' });
      return to(orderId, 'failed');
    }
    const transactionId = get('transaction_id');
    if (!validTransactionId(transactionId, attemptId, config.environment) || !verifyHash({ transactionId, totalCents: attempt.totalCents, apiKey: config.apiKey, hash: get('hash') })) {
      c.log.error('payment.hash_mismatch', { orderId, attemptId, totalCents: attempt.totalCents });
      c.waitUntil(alert(c, 'payment.hash_mismatch', { subject: 'A WiPay return failed verification', rows: [['Order', orderId], ['Attempt', attemptId]] }));
      return to(orderId, 'failed');
    }
    await confirmPayment(c, { attempt, attemptId, transactionId, reportedTotal: get('total'), currency: get('currency') });
    return to(orderId, 'paid');
  } catch (err) {
    c.log.error('payment.return_failed', { orderId, message: String(err?.message ?? err) });
    return to(orderId, 'failed');
  }
}
