// Payment through WiPay's hosted page. An order is paid only by confirmPayment, after the return hash checks out.
// Every decision is one version-checked commit, so double clicks, replayed returns and racing tabs settle once.
import { findOrder, changeOrder, revealOrder, jamaicaDay, holdKey, retryKey, ORDER_TTL } from './orders.js';
import { submissionKey } from './submissions.js';
import { wipayConfig, newAttemptId, requestPayment, formatTotal } from './wipay.js';
import { sendOrderEmails, BACKOFF_MINUTES } from './delivery.js';
import { alert } from './alerts.js';
import { HttpError } from './http.js';

export const attemptKey = id => `payment-attempt:${id}`;
export const txnKey = id => `wipay-txn:${id}`;
// Orders that reached WiPay, by the Jamaica day payment started: the daily summary lists the unpaid ones.
export const awaitingKey = (day, orderId) => `awaiting:${day}:${orderId}`;
// Paid orders by the Jamaica day they were paid, for the summary and Finances. No personal data, no TTL.
export const paidKey = (day, orderId) => `paid:${day}:${orderId}`;

const REUSE_MS = 150000; // WiPay's page expires after 3 minutes; reuse an open attempt for a little less
const keep = { expirationTtl: ORDER_TTL };

const freshAttempt = async (c, attemptId) => {
  if (!attemptId) return null;
  const a = await c.env.ORDERS.get(attemptKey(attemptId), 'json');
  return a?.state === 'open' && +c.now - Date.parse(a.createdAt) < REUSE_MS ? a : null;
};

// -> { paid: true } | { url }.
export async function startPayment(c, orderId) {
  const config = wipayConfig(c.env);
  if (!config) throw new HttpError('payments-unavailable', 503);
  const seen = await findOrder(c.env, orderId);
  if (!seen) throw new HttpError('unknown-order', 404);
  if (seen.paymentStatus === 'PAID') return { paid: true };
  if (seen.fulfilmentStatus === 'CANCELLED') throw new HttpError('order-cancelled', 409);
  const open = await freshAttempt(c, seen.attemptId);
  if (open) return { url: open.url };

  const attemptId = newAttemptId();
  const { customer, address } = await revealOrder(c.env, seen);
  const { url, transactionId } = await requestPayment(config, {
    attemptId, totalCents: seen.totalCents, customer, address,
    responseUrl: `${String(c.env.API_URL ?? '').replace(/\/+$/, '')}/api/payments/wipay/return`,
    version: String(c.env.COMMIT_SHA ?? '').slice(0, 16),
  });
  const attempt = { orderId, totalCents: seen.totalCents, currency: 'USD', url, wipayTransactionId: transactionId ?? null, createdAt: c.now.toISOString(), state: 'open' };
  let result = { url };
  await changeOrder(c.env, orderId, async cur => {
    if (cur.paymentStatus === 'PAID') { result = { paid: true }; return null; }
    if (cur.attemptId !== seen.attemptId) { // another tab won: its session is the one to show
      const won = await freshAttempt(c, cur.attemptId);
      if (won) { result = { url: won.url }; return null; }
    }
    const submission = await c.env.ORDERS.get(submissionKey(orderId));
    return {
      record: { ...cur, attemptId },
      extraPuts: [
        { key: attemptKey(attemptId), value: JSON.stringify(attempt), opts: keep },
        // From here the order may have money behind it, so its submission outlives the unpaid TTL.
        ...(submission ? [{ key: submissionKey(orderId), value: submission, opts: keep }] : []),
        { key: awaitingKey(jamaicaDay(+c.now), orderId), value: '', opts: keep },
      ],
    };
  });
  if (result.url === url) c.log.info('payment.started', { orderId, attemptId, totalCents: seen.totalCents });
  return result;
}

// The return hash checked out for `transactionId` on `attempt`. -> { orderId, outcome: 'paid' | 'already' | 'duplicate' }.
export async function confirmPayment(c, { attempt, attemptId, transactionId, reportedTotal, currency }) {
  const { orderId } = attempt;
  const products = c.data?.products ?? [];
  let outcome;
  const record = await changeOrder(c.env, orderId, async cur => {
    const txn = await c.env.ORDERS.get(txnKey(transactionId), 'json');
    if (txn) { outcome = txn.duplicate ? 'duplicate' : 'already'; return null; } // a replayed return
    if (cur.paymentStatus === 'PAID') { outcome = 'other'; return null; }
    const a = await c.env.ORDERS.getEntry(attemptKey(attemptId));
    const paidAt = c.now.toISOString();
    const { holdUntil, ...rest } = cur;
    const paid = {
      ...rest, status: 'PLACED', paymentStatus: 'PAID',
      payment: { provider: 'wipay', transactionId, paidAt, chargedTotal: reportedTotal || null, currency: currency || 'USD' },
      // Cost of goods as it stands when the money lands; a product gone since keeps the placed cost.
      lines: cur.lines.map(l => { const p = products.find(x => x.id === l.id); return p?.costCents != null ? { ...l, costCents: p.costCents } : l; }),
      events: [...(cur.events ?? []), { at: paidAt, type: 'paid', by: null }],
    };
    const submission = await c.env.ORDERS.get(submissionKey(orderId));
    outcome = 'paid';
    return {
      record: paid,
      extraChecks: [{ key: txnKey(transactionId), version: null }, { key: attemptKey(attemptId), version: a.version }],
      extraPuts: [
        { key: paidKey(jamaicaDay(+c.now), orderId), value: '', opts: { metadata: { totalCents: paid.totalCents, taxCents: paid.taxCents ?? 0, feeCents: paid.feeCents ?? 0, paidAt } } },
        { key: attemptKey(attemptId), value: JSON.stringify({ ...attempt, state: 'paid' }), opts: keep },
        { key: txnKey(transactionId), value: JSON.stringify({ orderId, attemptId, duplicate: false }), opts: keep },
        // Written with the payment, so a receipt lost to a restart is still sent by the cron.
        { key: retryKey(orderId), value: JSON.stringify({ retries: 0, nextAt: +c.now + BACKOFF_MINUTES[0] * 60000 }) },
        ...(submission ? [{ key: submissionKey(orderId), value: submission, opts: keep }] : []),
      ],
      deletes: holdUntil ? [holdKey(Date.parse(holdUntil), orderId)] : [],
    };
  });
  if (outcome === 'other') return recordDuplicate(c, { orderId, attempt, attemptId, transactionId });
  if (outcome !== 'paid') return { orderId, outcome };
  c.log.info('payment.confirmed', { orderId, attemptId, transactionId, totalCents: record.totalCents });
  if (reportedTotal && reportedTotal !== formatTotal(record.totalCents)) {
    c.log.warn('payment.total_mismatch', { orderId, attemptId, transactionId, totalCents: record.totalCents });
  }
  c.waitUntil(sendOrderEmails(c, record));
  return { orderId, outcome: 'paid' };
}

// The order was already paid by another transaction: the customer paid twice. Recorded once per transaction, and
// the owner is told once, since only the commit that writes wipay-txn alerts.
async function recordDuplicate(c, { orderId, attempt, attemptId, transactionId }) {
  const won = await c.env.ORDERS.commit({
    checks: [{ key: txnKey(transactionId), version: null }],
    puts: [
      { key: txnKey(transactionId), value: JSON.stringify({ orderId, attemptId, duplicate: true }), opts: keep },
      { key: attemptKey(attemptId), value: JSON.stringify({ ...attempt, state: 'paid' }), opts: keep },
    ],
  });
  if (won) {
    const order = await findOrder(c.env, orderId);
    c.log.error('payment.duplicate', { orderId, attemptId, transactionId });
    await alert(c, 'payment.duplicate', {
      subject: `Order ${orderId} was paid twice`, dedupe: false,
      rows: [['Order', orderId], ['First payment', order?.payment?.transactionId ?? ''], ['Second payment', transactionId], ['Action', 'Refund one in the WiPay dashboard']],
    });
  }
  return { orderId, outcome: 'duplicate' };
}

// A declined or abandoned payment: the attempt closes (if still open) and the order can be paid again.
export async function failAttempt(c, attemptId) {
  const e = await c.env.ORDERS.getEntry(attemptKey(attemptId));
  const a = e.value && JSON.parse(e.value);
  if (a?.state !== 'open') return;
  await c.env.ORDERS.commit({ checks: [{ key: attemptKey(attemptId), version: e.version }], puts: [{ key: attemptKey(attemptId), value: JSON.stringify({ ...a, state: 'failed' }), opts: keep }] });
}
