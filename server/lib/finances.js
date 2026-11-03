// Finances: money actually charged through WiPay, by the Jamaica day it was paid, and refunds by the day they were
// recorded. Reads the paid: and refund: indexes, and orders only for their lines and cost. Owners only.
import { PROCESSING_FEE, TAX } from '../../data/fees.js';
import { findOrder, ordersRev } from './orders.js';
import { listAll } from './stock.js';

const fee = cents => Math.floor((cents * PROCESSING_FEE.bps + 5000) / 10000); // half-up, as charges()
const CHUNK = 20;
const CACHE_MAX = 20;
const caches = new WeakMap(); // per ORDERS store

// shortcut: lists every paid:/refund: key and filters by day; switch to per-month prefixes past a few thousand orders
async function inRange(env, prefix, from, to) {
  const out = [];
  for (const { name, metadata } of await listAll(env.ORDERS, prefix)) {
    const day = name.slice(prefix.length, prefix.length + 10);
    if (day >= from && day <= to) out.push({ name, day, m: metadata ?? {} });
  }
  return out;
}

async function readOrders(env, ids) {
  const out = new Map();
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    (await Promise.all(chunk.map(id => findOrder(env, id)))).forEach((o, j) => { if (o) out.set(chunk[j], o); });
  }
  return out;
}

// Units of a line refunded back into stock: they were never sold, so they are no cost.
const restocked = (o, key) => (o.events ?? []).filter(e => e.type === 'refund' && e.restock).reduce((n, e) => n + (e.lines ?? []).filter(l => l.key === key).reduce((s, l) => s + l.qty, 0), 0);

async function compute(env, { from, to }) {
  const paid = await inRange(env, 'paid:', from, to);
  const refunds = await inRange(env, 'refund:', from, to);
  const orderIdOf = (prefix, name) => name.slice(prefix.length + 11).split(':')[0];
  const ids = [...new Set([...paid.map(p => orderIdOf('paid:', p.name)), ...refunds.map(r => orderIdOf('refund:', r.name))])];
  const orders = await readOrders(env, ids);
  const empty = !(await env.ORDERS.list({ prefix: 'paid:', limit: 1 })).keys.length;

  const months = new Map();
  const month = day => months.get(day.slice(0, 7)) ?? months.set(day.slice(0, 7), { month: day.slice(0, 7), orders: 0, revenueCents: 0, refundsCents: 0, taxCents: 0, refundedTaxCents: 0, feesCents: 0, cogsCents: 0 }).get(day.slice(0, 7));
  const products = new Map();
  const rows = [];
  let costMissing = 0;
  for (const p of paid) {
    const id = orderIdOf('paid:', p.name), o = orders.get(id);
    const totalCents = p.m.totalCents ?? o?.totalCents ?? 0, taxCents = p.m.taxCents ?? o?.taxCents ?? 0;
    const bucket = month(p.day);
    let cogsCents = 0;
    for (const l of o?.lines ?? []) {
      const sold = l.qty - restocked(o, l.key);
      if (l.costCents == null) costMissing++;
      else cogsCents += l.costCents * sold;
      const item = products.get(l.id) ?? products.set(l.id, { id: l.id, name: l.name, units: 0, revenueCents: 0, costCents: 0 }).get(l.id);
      item.units += sold; item.revenueCents += l.unitCents * sold; item.costCents += (l.costCents ?? 0) * sold;
    }
    Object.assign(bucket, { orders: bucket.orders + 1, revenueCents: bucket.revenueCents + totalCents, taxCents: bucket.taxCents + taxCents, feesCents: bucket.feesCents + fee(totalCents), cogsCents: bucket.cogsCents + cogsCents });
    rows.push({ id, paidAt: p.m.paidAt ?? o?.payment?.paidAt ?? '', subtotalCents: o?.subtotalCents ?? 0, taxCents, feeCents: fee(totalCents), totalCents, cogsCents, refundedCents: o?.refundedCents ?? 0 });
  }
  const refundList = [];
  for (const r of refunds) {
    const id = orderIdOf('refund:', r.name), at = r.name.slice('refund:'.length + 11 + id.length + 1).split(':').slice(0, 3).join(':');
    const bucket = month(r.day);
    bucket.refundsCents += r.m.amountCents ?? 0;
    bucket.refundedTaxCents += r.m.taxCents ?? 0;
    const ev = orders.get(id)?.events?.find(e => e.type === 'refund' && e.at === at);
    refundList.push({ orderId: id, at, reason: ev?.reason ?? '', amountCents: r.m.amountCents ?? 0, taxCents: r.m.taxCents ?? 0, restock: !!r.m.restock });
  }
  const shaped = [...months.values()].sort((a, b) => a.month.localeCompare(b.month)).map(m => {
    const gctOwedCents = m.taxCents - m.refundedTaxCents;
    return { ...m, gctOwedCents, profitCents: m.revenueCents - m.refundsCents - gctOwedCents - m.feesCents - m.cogsCents };
  });
  const sum = k => shaped.reduce((n, m) => n + m[k], 0);
  const netCents = sum('revenueCents') - sum('refundsCents');
  const profitCents = sum('profitCents');
  // Product profit: item revenue less its cost and the WiPay fee on what the customer paid for it (with GCT).
  const bestSellers = [...products.values()].map(({ costCents, ...p }) => ({ ...p, profitCents: p.revenueCents - costCents - fee(Math.round(p.revenueCents * (10000 + TAX.bps) / 10000)) }))
    .sort((a, b) => b.profitCents - a.profitCents);
  return {
    data: {
      empty, revenueCents: sum('revenueCents'), refundsCents: sum('refundsCents'), netCents, gctOwedCents: sum('gctOwedCents'),
      feesCents: sum('feesCents'), cogsCents: sum('cogsCents'), costMissing, profitCents, marginBps: netCents ? Math.round(profitCents * 10000 / netCents) : 0,
      bestSellers, refunds: refundList.sort((a, b) => b.at.localeCompare(a.at)).map(({ taxCents, restock, ...r }) => r),
      months: shaped.map(({ month, orders, revenueCents, gctOwedCents, profitCents }) => ({ month, orders, revenueCents, gctOwedCents, profitCents })),
    },
    rows, refundRows: refundList,
  };
}

// Cached per range until an order changes (ordersRev).
async function cached(env, range) {
  const cache = caches.get(env.ORDERS) ?? caches.set(env.ORDERS, new Map()).get(env.ORDERS);
  const key = JSON.stringify([range.from, range.to, ordersRev()]);
  if (!cache.has(key)) {
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(key, compute(env, range).catch(err => { cache.delete(key); throw err; }));
  }
  return cache.get(key);
}

export async function finances(env, { from, to }) {
  return (await cached(env, { from, to })).data;
}

const csvCell = v => (/[",\r\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
const csvRows = (header, rows) => [header.join(','), ...rows.map(r => header.map(h => csvCell(r[h])).join(','))];

// Paid orders, then refunds. Amounts in cents; no customer details.
export async function financesCsv(env, { from, to }) {
  const { rows, refundRows } = await cached(env, { from, to });
  return [
    ...csvRows(['id', 'paidAt', 'subtotalCents', 'taxCents', 'feeCents', 'totalCents', 'cogsCents', 'refundedCents'], rows),
    '',
    ...csvRows(['orderId', 'at', 'amountCents', 'taxCents', 'restock'], refundRows),
  ].join('\r\n') + '\r\n';
}
