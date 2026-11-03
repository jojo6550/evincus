// Stock held for an unpaid order: released when the hold expires, re-held when a payment arrives after that, and
// unpaid orders that never reached WiPay swept after a week. Every move is one commit checking the order and each
// stock document it touches, so a hold is released at most once and never after a cancel or a payment.
import { orderKey, orderPuts, holdKey, findOrder, changeOrder, bumpOrders, UNPAID_TTL } from './orders.js';
import { stockKey, stockDoc, adjKey } from './stock.js';
import { walkDays } from './retention.js';
import { alert } from './alerts.js';

const ROUNDS = 5;
const pause = () => new Promise(r => setTimeout(r, 5 + Math.random() * 20));
const quiet = { error() {} };
const variantOf = l => `${l.color}|${l.size}`;
const idOfHold = name => name.slice('hold:'.length + 14); // hold:<13-digit ms>:<id>

async function stockEntries(env, lines) {
  const ids = [...new Set(lines.map(l => l.id))];
  return new Map(await Promise.all(ids.map(async pid => [pid, await env.ORDERS.getEntry(stockKey(pid))])));
}

// One commit: the order (version-checked) and its stock documents, each line's committed moved by `sign * qty`.
// `fits(line, doc)` may refuse a line (re-hold with no units left). -> true committed, false lost a race, null refused.
async function moveStock(env, { cur, version, record, sign, reason, now, opId, fits = () => true, deletes = [] }) {
  const entries = await stockEntries(env, cur.lines);
  const docs = new Map([...entries].map(([pid, e]) => [pid, JSON.parse(e.value ?? '{}')]));
  const at = now.toISOString();
  const adjs = [];
  for (const [i, l] of cur.lines.entries()) {
    const doc = docs.get(l.id), variant = variantOf(l);
    if (!Object.hasOwn(doc, variant)) continue; // renamed or removed since the order: nothing to move
    if (!fits(l, doc[variant])) return null;
    const committed = Math.max(0, (doc[variant].committed ?? 0) + sign * l.qty);
    doc[variant] = { ...doc[variant], committed };
    adjs.push({ key: adjKey(l.id, at, opId, i), value: JSON.stringify({ key: l.key, onHand: 0, committed: sign * l.qty, reason, note: '', by: null, at, orderId: cur.id }) });
  }
  const ok = await env.ORDERS.commit({
    checks: [{ key: orderKey(cur.id), version }, ...[...entries].map(([pid, e]) => ({ key: stockKey(pid), version: e.version }))],
    puts: [...orderPuts(record), ...[...docs].map(([pid, doc]) => ({ key: stockKey(pid), value: stockDoc(doc) })), ...adjs],
    deletes,
  });
  if (ok) bumpOrders();
  return ok;
}

// -> 'released' | 'paid' | 'gone' | 'not-expired' | 'cancelled'. `key` is the hold: key being worked, deleted when stale.
export async function releaseHold(env, orderId, { now, key } = {}) {
  for (let round = 0; round < ROUNDS; round++) {
    if (round) await pause();
    const { value, version } = await env.ORDERS.getEntry(orderKey(orderId));
    const stale = async outcome => { if (key) await env.ORDERS.delete(key); return outcome; };
    if (!value) return stale('gone');
    const cur = JSON.parse(value);
    if (cur.paymentStatus === 'PAID') return stale('paid');
    if (cur.fulfilmentStatus === 'CANCELLED') return stale('cancelled');
    if (cur.stockCommitted !== true || !cur.holdUntil) return stale('not-expired');
    if (Date.parse(cur.holdUntil) > +now) return 'not-expired';
    const { holdUntil, ...rest } = cur;
    const record = { ...rest, stockCommitted: false, events: [...(cur.events ?? []), { at: now.toISOString(), type: 'hold-released', by: null }] };
    const deletes = [holdKey(Date.parse(holdUntil), orderId), ...(key ? [key] : [])];
    if (await moveStock(env, { cur, version, record, sign: -1, reason: 'hold-released', now, opId: `hold-${orderId}`, deletes })) return 'released';
  }
  return 'not-expired'; // kept racing: the next run tries again
}

// Releases due holds, oldest first, at most `limit` a run; the rest stay listed for the next run. -> holds released.
export async function releaseExpiredHolds(env, now, { deadline = Infinity, limit = 50, log = quiet } = {}) {
  const page = await env.ORDERS.list({ prefix: 'hold:', limit });
  const due = page.keys.map(k => k.name).filter(name => name <= holdKey(+now, '~'));
  let n = 0;
  for (const name of due) {
    if (Date.now() >= deadline) break;
    try { if ((await releaseHold(env, idOfHold(name), { now, key: name })) === 'released') n++; }
    catch (err) { log.error('hold.release_failed', { orderId: idOfHold(name), message: String(err?.message ?? err) }); }
  }
  return n;
}

// Deletes unpaid orders over a week old that never reached WiPay. An order with an attemptId is kept: startPayment
// writes it in the same commit as the attempt and the awaiting: entry, and a WiPay transaction needs an attempt, so it
// is the one marker of money that may exist. Held stock is released first (releaseExpiredHolds). -> orders deleted.
export async function sweepUnpaid(env, now, { deadline = Infinity, log = quiet } = {}) {
  const cutoff = new Date(+now - UNPAID_TTL * 1000).toISOString();
  let n = 0;
  await walkDays(env, 'holds:sweep-cursor', deadline, async ({ name, metadata }) => {
    if (metadata?.payment !== 'UNPAID' || !(metadata.placedAt < cutoff)) return false;
    const id = name.slice(name.indexOf(':', 4) + 1);
    try {
      const { value, version } = await env.ORDERS.getEntry(orderKey(id));
      const o = value && JSON.parse(value);
      if (!o || o.paymentStatus !== 'UNPAID' || o.attemptId || o.stockCommitted === true) return false;
      const ok = await env.ORDERS.commit({ checks: [{ key: orderKey(id), version }], deletes: [orderKey(id), name] });
      if (ok) { bumpOrders(); n++; }
    } catch (err) { log.error('hold.sweep_failed', { orderId: id, message: String(err?.message ?? err) }); }
    return false;
  });
  return n;
}

// Holds stock again for a paid order whose hold was lost, when the units are still there. A cancelled order is never
// re-held. -> 'held' | 'lost' | 'noop'.
export async function recommit(env, orderId, { now, products = [] } = {}) {
  for (let round = 0; round < ROUNDS; round++) {
    if (round) await pause();
    const { value, version } = await env.ORDERS.getEntry(orderKey(orderId));
    const cur = value && JSON.parse(value);
    if (!cur || cur.paymentStatus !== 'PAID' || cur.stockCommitted === true) return 'noop';
    if (cur.fulfilmentStatus === 'CANCELLED') return 'lost';
    const { holdLost, ...rest } = cur;
    const record = { ...rest, stockCommitted: true };
    const fits = (l, s) => products.find(p => p.id === l.id)?.continueSelling === true || (s.onHand ?? 0) - (s.committed ?? 0) >= l.qty;
    const ok = await moveStock(env, { cur, version, record, sign: 1, reason: 'order', now, opId: `recommit-${orderId}`, fits });
    if (ok === null) return 'lost';
    if (ok) return 'held';
  }
  return 'lost';
}

// After a payment that found its hold gone: re-hold the stock if it is still there, else tell the owner, once.
// `alert` dedupes per event name, so the name is per order; the marker is set only once the alert went out, so a
// failed send is retried by redriveLate. -> 'held' | 'lost'.
export async function lateFollowUp(c, orderId) {
  await recommit(c.env, orderId, { now: c.now, products: c.data?.products });
  const o = await findOrder(c.env, orderId);
  if (!o || o.stockCommitted === true) return 'held';
  if (!o.alertedLate) {
    const sent = await alert(c, `payment.late:${orderId}`, {
      subject: `Order ${orderId} was paid after its stock hold expired`,
      rows: [['Order', orderId], ['WiPay transaction', o.payment?.transactionId ?? ''], ['Action', 'Restock it, or refund it in the WiPay dashboard and record the refund']],
    });
    if (sent) await changeOrder(c.env, orderId, r => ({ ...r, alertedLate: true }));
  }
  return 'lost';
}

// Cron: finishes the follow-up for paid orders still without their stock (a crash after the paid commit, or a failed
// alert). Found from day: metadata. -> orders followed up.
export async function redriveLate(c) {
  let n = 0;
  await walkDays(c.env, 'holds:late-cursor', c.deadline ?? Infinity, async ({ name, metadata }) => {
    if (metadata?.payment !== 'PAID' || metadata.stockCommitted !== false || metadata.holdLost !== true) return false;
    const id = name.slice(name.indexOf(':', 4) + 1);
    const o = await findOrder(c.env, id);
    if (!o || o.alertedLate) return false;
    try { await lateFollowUp(c, id); n++; }
    catch (err) { c.log.error('hold.late_failed', { orderId: id, message: String(err?.message ?? err) }); }
    return false;
  });
  return n;
}
