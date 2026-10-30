import { money } from '../../data/catalog.js';
import { HttpError } from './http.js';
import { applyAction, orderSummary } from './order-flow.js';
import { stockKey, stockDoc, adjKey } from './stock.js';
import { isOpId, readOpEntry, opPut } from './ops.js';
import { MAX_PRODUCTS } from './pricing.js';

export const ORDER_TTL = 63072000; // 2 years
export const orderKey = id => `order:${id}`;
export const retryKey = id => `email-retry:${id}`;

export const findOrder = (env, id) => env.ORDERS.get(orderKey(id), 'json');

// The Jamaica day an order was placed (UTC-5, no DST).
export function dayKey(record) {
  const day = new Date(Date.parse(record.placedAt) - 5 * 3600000).toISOString().slice(0, 10);
  return `day:${day}:${record.id}`;
}

// The order and its day: entry, whose metadata lets the order list skip reading each record. No TTL: amounts are kept
// forever (retention.js scrubs the personal fields after 2 years).
export const orderPuts = record => [
  { key: orderKey(record.id), value: JSON.stringify(record) },
  { key: dayKey(record), value: '', opts: { metadata: orderSummary(record) } },
];
const ROUNDS = 5;
const pause = () => new Promise(r => setTimeout(r, 5 + Math.random() * 20));

// Applies `change` to a fresh copy of the stored order and commits it only if the order is unchanged since that read,
// so a slow writer (email delivery) never puts back a stale record over an owner's action. `change` returns the new
// record, or { record, extraPuts }. -> the record written.
export async function changeOrder(env, id, change) {
  for (let round = 0; round < ROUNDS; round++) {
    if (round) await pause();
    const { value, version } = await env.ORDERS.getEntry(orderKey(id));
    if (!value) throw new HttpError('unknown-order', 404);
    const out = change(JSON.parse(value));
    const { record, extraPuts = [] } = out.record ? out : { record: out };
    if (await env.ORDERS.commit({ checks: [{ key: orderKey(id), version }], puts: [...orderPuts(record), ...extraPuts] })) return record;
  }
  throw new HttpError('order-busy', 409);
}

// Product ids never hold '|', so a line key splits at its first one into product and '<colour>|<size>'.
const splitLine = key => [key.slice(0, key.indexOf('|')), key.slice(key.indexOf('|') + 1)];

// An owner's action on an order, with its stock movements, in one commit: the order, each moved product's stock
// document and op:<opId> are checked, so a retry or a racing twin applies it once and a raced stock read retries.
// `version` is the order version the owner saw; any other is 409 order-changed, also after a lost round, so an
// action is never re-applied onto an order that changed since. -> { order, version, replayed }.
export async function orderAction(env, id, { opId, version, action }, { by, now }) {
  if (!isOpId(opId)) throw new HttpError('invalid-action', 400);
  const key = orderKey(id);
  for (let round = 0; round < ROUNDS; round++) {
    if (round) await pause();
    const op = await readOpEntry(env, opId, 'order-action'); // first, so a retry replays whatever changed since
    if (op.result && op.result.id !== id) throw new HttpError('op-reused', 409);
    if (!op.result) {
      const cur = await env.ORDERS.getEntry(key);
      if (!cur.value) throw new HttpError('unknown-order', 404);
      const current = JSON.parse(cur.value);
      if (cur.version !== version) throw new HttpError('order-changed', 409, { current, version: cur.version });
      const { record, movements } = applyAction(current, action, { by, now });
      const ids = [...new Set(movements.map(m => splitLine(m.key)[0]))];
      // One check per moved stock doc plus the order and the op must fit @deno/kv's 10 checks; checkout caps an order at MAX_PRODUCTS.
      if (ids.length > MAX_PRODUCTS) throw new Error(`Order ${id} moves stock of ${ids.length} products; one commit fits ${MAX_PRODUCTS}`);
      const entries = new Map(await Promise.all(ids.map(async pid => [pid, await env.ORDERS.getEntry(stockKey(pid))])));
      const docs = new Map([...entries].map(([pid, e]) => [pid, JSON.parse(e.value ?? '{}')]));
      const at = now.toISOString();
      const adjs = movements.map((m, i) => {
        const [pid, variant] = splitLine(m.key);
        const doc = docs.get(pid);
        // The stock document lists every variant, so a missing row was renamed or removed since the order.
        if (!Object.hasOwn(doc, variant)) throw new HttpError('variant-gone', 409, { key: m.key });
        const onHand = (doc[variant].onHand ?? 0) + m.onHand, committed = (doc[variant].committed ?? 0) + m.committed;
        // Committed counts open orders' units, so it can't go below zero unless the data is wrong.
        if (committed < 0) throw new HttpError('stock-mismatch', 409, { key: m.key });
        if (onHand < 0) throw new HttpError('stock-short', 409, { key: m.key }); // e.g. an oversold continueSelling product
        doc[variant] = { ...doc[variant], onHand, committed };
        return { key: adjKey(pid, at, opId, i), value: JSON.stringify({ key: m.key, onHand: m.onHand, committed: m.committed, reason: m.reason, note: '', by, at, orderId: id }) };
      });
      const ok = await env.ORDERS.commit({
        checks: [{ key, version: cur.version }, ...[...entries].map(([pid, e]) => ({ key: stockKey(pid), version: e.version })), op.check],
        puts: [...orderPuts(record), ...[...docs].map(([pid, doc]) => ({ key: stockKey(pid), value: stockDoc(doc) })), ...adjs, opPut(opId, 'order-action', { id })],
      });
      if (!ok) continue;
    }
    // The commit can't know its own version, so the result is read back, like a product save's.
    const e = await env.ORDERS.getEntry(orderKey(op.result?.id ?? id));
    return { order: JSON.parse(e.value), version: e.version, replayed: !!op.result };
  }
  throw new HttpError('order-busy', 409);
}

// Label/value rows for the owner's daily summary.
export function recordRows(r) {
  return [
    ['Status', 'Placed — no payment collected'], ['Placed at', r.placedAt], ['Phone', r.customer.phone], ['Pickup', r.fulfillment.location ? `${r.fulfillment.location.name}, ${r.fulfillment.location.address ?? r.fulfillment.location.area + ' (address to be confirmed)'}` : ''], ['Notes', r.notes],
    ['Order', r.id],
    ['Payer', `${r.payer.name} <${r.payer.email}>`],
    ...r.lines.map(l => [`${l.qty} × ${l.name}`, `${l.color} / ${l.size} at ${money(l.unitCents)}`]),
    ['Subtotal', money(r.subtotalCents)],
    ['Total', `${money(r.totalCents)} USD`],
  ];
}
