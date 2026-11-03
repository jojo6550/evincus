import { HttpError } from './http.js';
import { jamaicaDay, listOrders, findOrder, ordersRev } from './orders.js';
import { remaining } from '../../data/refunds.js';
import { lineKey } from '../../data/catalog.js';

const DAY = 86400000;
const MAX_DAYS = 366; // each day is one KV walk
const TOP = 8, LOW_MAX = 30;
const isDay = d => /^\d{4}-\d{2}-\d{2}$/.test(d ?? '') && new Date(Date.parse(`${d}T00:00:00Z`) || 0).toISOString().startsWith(d);
const shift = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const span = (a, b) => (Date.parse(b) - Date.parse(a)) / DAY + 1;

// The Jamaica-day range of a period and the same-length range right before it, or 400 invalid-query.
export function periodBounds(period, now, { from, to } = {}) {
  const today = jamaicaDay(+now);
  let start, end = today;
  if (period === 'today') start = today;
  else if (period === '7d') start = shift(today, -6);
  else if (period === '30d') start = shift(today, -29);
  else if (period === 'custom' && isDay(from) && isDay(to) && span(from, to) >= 1 && span(from, to) <= MAX_DAYS) [start, end] = [from, to];
  else throw new HttpError('invalid-query', 400);
  const n = span(start, end);
  return { from: start, to: end, prevFrom: shift(start, -n), prevTo: shift(start, -1) };
}

// Placed orders that count: not cancelled, not waiting for payment.
const counts = m => m.fulfilment !== 'CANCELLED' && m.payment !== 'UNPAID';
const dayOf = m => jamaicaDay(Date.parse(m.placedAt));
const net = m => m.totalCents - (m.refundedCents || 0); // the processing fee stays in: it is never refunded
const within = (m, a, b) => { const d = dayOf(m); return d >= a && d <= b; };

function total(rows) {
  const sales = rows.reduce((s, m) => s + net(m), 0), units = rows.reduce((s, m) => s + m.units, 0);
  return { sales, orders: rows.length, units, average: rows.length ? Math.round(sales / rows.length) : 0 };
}
const top = map => [...map.values()].sort((a, b) => b.units - a.units || b.cents - a.cents || (a.name < b.name ? -1 : 1)).slice(0, TOP);

// rows: day-index summaries { id, ...orderSummary, lines? } for the period and the one before. `lines` ({ id, name, color,
// size, qty net of refunds, unitCents }) is set on the period's rows only; tiles and perDay use the summaries alone.
export function computeStats(rows, catalog, stock, bounds) {
  const live = rows.filter(counts);
  const cur = live.filter(m => within(m, bounds.from, bounds.to)), prev = live.filter(m => within(m, bounds.prevFrom, bounds.prevTo));
  const perDay = [];
  for (let d = bounds.from; d <= bounds.to; d = shift(d, 1)) perDay.push({ day: d, cents: 0, orders: 0 });
  const at = new Map(perDay.map(p => [p.day, p]));
  for (const m of cur) { const p = at.get(dayOf(m)); p.cents += net(m); p.orders++; }

  const eraOf = new Map(catalog.products.map(p => [p.id, p.era]));
  const best = { product: new Map(), era: new Map(), colour: new Map(), size: new Map() };
  const add = (map, key, name, l) => {
    const e = map.get(key) ?? map.set(key, { key, name, units: 0, cents: 0 }).get(key);
    e.units += l.qty;
    e.cents += l.qty * l.unitCents;
  };
  for (const m of cur) for (const l of m.lines ?? []) {
    if (l.qty <= 0) continue;
    add(best.product, l.id, l.name, l);
    add(best.era, eraOf.get(l.id) ?? '', eraOf.get(l.id) ?? 'unknown', l);
    add(best.colour, l.color, l.color, l);
    add(best.size, l.size, l.size, l);
  }
  const pickups = new Map();
  for (const m of cur.filter(m => m.type === 'pickup')) {
    const e = pickups.get(m.locationId) ?? pickups.set(m.locationId, { locationId: m.locationId, orders: 0, cents: 0 }).get(m.locationId);
    e.orders++;
    e.cents += net(m);
  }
  const sizes = top(best.size);
  return {
    tiles: { ...total(cur), prev: total(prev) },
    perDay,
    best: { product: top(best.product), era: top(best.era), colour: top(best.colour), size: sizes },
    sizes,
    pickup: [...pickups.values()].sort((a, b) => b.orders - a.orders),
    low: lowStock(catalog, stock),
  };
}

// Active variants with Available <= lowStockAt, emptiest first.
export function lowStock(catalog, stock) {
  const out = [];
  for (const p of catalog.products) {
    if ((p.status ?? 'active') !== 'active') continue;
    for (const c of p.colors) for (const size of p.sizes) {
      const s = stock.get(lineKey(p.id, c.name, size)) ?? { onHand: 0, committed: 0 };
      const available = s.onHand - s.committed;
      if (available <= (p.lowStockAt ?? 3)) out.push({ id: p.id, name: p.name, color: c.name, size, available, out: available <= 0 });
    }
  }
  return out.sort((a, b) => a.available - b.available || (a.name < b.name ? -1 : 1)).slice(0, LOW_MAX);
}

// Every day-index row of a range, paged through listOrders (its 50-row pages re-read a day that spans pages).
async function dayRows(env, from, to) {
  const rows = [];
  for (let cursor; ;) {
    const out = await listOrders(env, { from, to, keep: () => true, cursor });
    rows.push(...out.orders);
    if (!out.cursor) return rows;
    const i = out.cursor.indexOf('|');
    cursor = { placedAt: out.cursor.slice(0, i), id: out.cursor.slice(i + 1) };
  }
}

const CACHE_MAX = 20;
const CACHE_TTL = 60000;
const caches = new WeakMap(); // per ORDERS store, so tests with separate stores do not share

// The order-derived part is cached per (period, range, ordersRev, catalog rev); `low` always reads the current stock.
// shortcut: loads every order in the period; precompute daily aggregates if periods get slow
export async function loadStats(env, { period, now, from, to, catalog, stock, rev }) {
  const b = periodBounds(period, now, { from, to });
  const cache = caches.get(env.ORDERS) ?? caches.set(env.ORDERS, new Map()).get(env.ORDERS);
  const key = JSON.stringify([period, b.from, b.to, ordersRev(), rev]);
  const cached = cache.get(key);
  let hit = cached && Date.now() - cached.at < CACHE_TTL ? cached.value : null;
  if (!hit) {
    const rows = await dayRows(env, b.prevFrom, b.to);
    const counted = rows.filter(m => counts(m) && within(m, b.from, b.to));
    for (let i = 0; i < counted.length; i += 10) {
      await Promise.all(counted.slice(i, i + 10).map(async m => {
        const o = await findOrder(env, m.id);
        m.lines = (o?.lines ?? []).map(l => ({ id: l.id, name: l.name, color: l.color, size: l.size, unitCents: l.unitCents, qty: remaining(o, l) }));
      }));
    }
    hit = computeStats(rows, catalog, new Map(), b);
    cache.delete(key); // re-inserted last, so eviction drops the oldest
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(key, { at: Date.now(), value: hit });
  }
  return { ...hit, low: lowStock(catalog, stock), period, from: b.from, to: b.to };
}
