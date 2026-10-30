import test from 'node:test';
import assert from 'node:assert/strict';
import { call, makeEnv } from './helpers/fake-env.mjs';
import { signIn, ADMIN_TOKEN } from './helpers/staff.mjs';
import { FIXTURE, NOW, fixtureStock } from './helpers/fixture.mjs';
import { orderPuts, changeOrder } from '../server/lib/orders.js';
import { orderSummary } from '../server/lib/order-flow.js';
import { periodBounds, computeStats } from '../server/lib/stats.js';
import { remaining } from '../data/refunds.js';
import { barChart, bucketed } from '../assets/js/inventory-chart.js';

const HOUR = 3600000, DAY = 24 * HOUR;
let seq = 0;
const line = (over = {}) => ({ key: 'alpha-tee|Black, white print|S', id: 'alpha-tee', name: 'Alpha Tee', color: 'Black, white print', size: 'S', qty: 2, unitCents: 3499, costCents: 1200, ...over });
const mk = ({ at = NOW - HOUR, payment = 'PAID', fulfilment = 'UNFULFILLED', loc = 'trendy-hats', lines = [line()], ...over } = {}) => ({
  id: `EV-${String(++seq).padStart(8, '0')}`, status: 'PLACED', paymentStatus: payment, fulfilmentStatus: fulfilment,
  placedAt: new Date(at).toISOString(), stockCommitted: true, fulfillment: { type: 'pickup', location: { id: loc, name: 'X', area: 'Y' } },
  lines, subtotalCents: 0, totalCents: lines.reduce((s, l) => s + l.qty * l.unitCents, 0),
  customer: { name: 'Ann Lee', email: 'ann@example.com', phone: '+1 555 123 4567' }, payer: { name: 'Ann Lee', email: 'ann@example.com' }, notes: 'secret note', events: [],
  ...over,
});
// A day-index row with its net lines, as loadStats builds it.
const row = o => ({ id: o.id, ...orderSummary(o), lines: o.lines.map(l => ({ ...l, qty: remaining(o, l) })) });
const bounds = periodBounds('7d', new Date(NOW));

test('stats count placed orders, exclude cancelled and awaiting payment, subtract refunded units', () => {
  const a = mk(), b = mk({ lines: [line({ qty: 3 })], refundedQty: { 'alpha-tee|Black, white print|S': 1 }, paymentStatus: 'PARTIALLY_REFUNDED' });
  const out = [mk({ fulfilmentStatus: 'CANCELLED' }), mk({ paymentStatus: 'UNPAID' })];
  const s = computeStats([a, b, ...out].map(row), FIXTURE, fixtureStock(), bounds);
  assert.equal(s.tiles.orders, 2);
  assert.equal(s.tiles.units, 2 + 2);
  assert.equal(s.tiles.sales, a.totalCents + b.totalCents);
  assert.equal(s.tiles.average, Math.round((a.totalCents + b.totalCents) / 2));
  assert.equal(s.best.product[0].units, 4);
  assert.equal(s.sizes[0].name, 'S');
  assert.deepEqual(s.pickup, [{ locationId: 'trendy-hats', orders: 2, cents: a.totalCents + b.totalCents }]);
});

test('previous period has the same length', () => {
  assert.deepEqual(periodBounds('today', new Date(NOW)), { from: '2026-10-03', to: '2026-10-03', prevFrom: '2026-10-02', prevTo: '2026-10-02' });
  assert.deepEqual(periodBounds('7d', new Date(NOW)), { from: '2026-09-27', to: '2026-10-03', prevFrom: '2026-09-20', prevTo: '2026-09-26' });
  assert.deepEqual(periodBounds('30d', new Date(NOW)), { from: '2026-09-04', to: '2026-10-03', prevFrom: '2026-08-05', prevTo: '2026-09-03' });
  assert.deepEqual(periodBounds('custom', new Date(NOW), { from: '2026-10-01', to: '2026-10-03' }), { from: '2026-10-01', to: '2026-10-03', prevFrom: '2026-09-28', prevTo: '2026-09-30' });
  const s = computeStats([mk(), mk({ at: NOW - 9 * DAY })].map(row), FIXTURE, fixtureStock(), bounds); // 24 Sep: previous 7 days
  assert.equal(s.tiles.orders, 1);
  assert.equal(s.tiles.prev.orders, 1);
  assert.equal(s.perDay.length, 7);
});

test('a period outside the allowed shapes is invalid-query', () => {
  const bad = [['year'], ['custom'], ['custom', { from: '2026-10-03', to: '2026-10-01' }], ['custom', { from: '2025-10-01', to: '2026-10-03' }], ['custom', { from: 'x', to: '2026-10-03' }]];
  for (const [p, r] of bad) assert.throws(() => periodBounds(p, new Date(NOW), r), { code: 'invalid-query' }, p);
  assert.doesNotThrow(() => periodBounds('custom', new Date(NOW), { from: '2025-10-03', to: '2026-10-03' })); // 366 days
});

test('Jamaica day boundaries put a 23:30 UTC-5 order on its local day', () => {
  const late = mk({ at: Date.parse('2026-10-03T04:30:00Z') }); // 23:30 on 2 Oct in Jamaica
  const early = mk({ at: Date.parse('2026-10-03T05:30:00Z') }); // 00:30 on 3 Oct
  const s = computeStats([late, early].map(row), FIXTURE, fixtureStock(), bounds);
  const by = Object.fromEntries(s.perDay.map(p => [p.day, p.orders]));
  assert.equal(by['2026-10-02'], 1);
  assert.equal(by['2026-10-03'], 1);
});

test('running-low lists variants at or under lowStockAt, worst first', () => {
  const stock = fixtureStock();
  stock.set('alpha-tee|Black, white print|S', { onHand: 5, committed: 3 }); // 2 available
  stock.set('alpha-tee|Black, white print|M', { onHand: 2, committed: 4 }); // -2: worst
  stock.set('old-tee|Black|M', { onHand: 0, committed: 0 });
  const products = FIXTURE.products.map(p => (p.id === 'old-tee' ? { ...p, status: 'archived' } : p));
  const { low } = computeStats([], { ...FIXTURE, products }, stock, bounds);
  assert.deepEqual(low.map(l => [l.id, l.color, l.size, l.available, l.out]), [
    ['alpha-tee', 'Black, white print', 'M', -2, true],
    ['alpha-tee', 'White', 'M', 0, true], // ties by product name
    ['alpha-hood', 'Black', 'M', 0, true],
    ['alpha-tee', 'Black, white print', 'S', 2, false],
  ]);
});

const setup = async () => {
  const env = makeEnv({ ADMIN_TOKEN });
  return { env, owner: await signIn(env), viewer: await signIn(env, 'viewer') };
};
const get = (env, cookie, path) => call('GET', path, { env, headers: { cookie } });

test('a viewer gets no customer, cost or profit fields', async () => {
  const { env, owner, viewer } = await setup();
  await env.ORDERS.commit({ puts: orderPuts(mk()) });
  for (const cookie of [viewer, owner]) {
    const r = await get(env, cookie, '/api/inventory/stats?period=7d');
    assert.equal(r.status, 200);
    assert.equal(r.json.tiles.orders, 1);
    // An allowlist of keys at every level: a new field must be added here on purpose.
    const keys = o => Object.keys(o).sort();
    const j = r.json;
    assert.deepEqual(keys(j), ['best', 'from', 'low', 'perDay', 'period', 'pickup', 'sizes', 'tiles', 'to']);
    assert.deepEqual(keys(j.tiles), ['average', 'orders', 'prev', 'sales', 'units']);
    assert.deepEqual(keys(j.tiles.prev), ['average', 'orders', 'sales', 'units']);
    assert.deepEqual(keys(j.best), ['colour', 'era', 'product', 'size']);
    for (const list of [...Object.values(j.best), j.sizes]) for (const e of list) assert.deepEqual(keys(e), ['cents', 'key', 'name', 'units']);
    for (const e of j.perDay) assert.deepEqual(keys(e), ['cents', 'day', 'orders']);
    for (const e of j.pickup) assert.deepEqual(keys(e), ['cents', 'locationId', 'orders']);
    for (const e of j.low) assert.deepEqual(keys(e), ['available', 'color', 'id', 'name', 'out', 'size']);
  }
});

test('a refunded order lowers units and the product count through the route', async () => {
  const { env, viewer } = await setup();
  const key = 'alpha-tee|Black, white print|S';
  await env.ORDERS.commit({ puts: [...orderPuts(mk({ lines: [line({ qty: 3 })], refundedQty: { [key]: 1 }, paymentStatus: 'PARTIALLY_REFUNDED' })), ...orderPuts(mk({ lines: [line({ qty: 1 })] }))] });
  const { json } = await get(env, viewer, '/api/inventory/stats?period=7d');
  assert.equal(json.tiles.orders, 2);
  assert.equal(json.tiles.units, 3);
  assert.equal(json.best.product[0].units, 3);
  assert.equal(json.sizes[0].units, 3);
});

test('a day with more than 50 orders is counted whole across list pages', async () => {
  const { env, viewer } = await setup();
  const many = Array.from({ length: 55 }, (_, i) => mk({ at: NOW - HOUR - i * 1000 }));
  await env.ORDERS.commit({ puts: many.flatMap(orderPuts) });
  const { json } = await get(env, viewer, '/api/inventory/stats?period=today');
  assert.equal(json.tiles.orders, 55);
  assert.equal(json.tiles.units, 110);
  assert.equal(json.best.product[0].units, 110);
  assert.equal(json.perDay[0].orders, 55);
});

test('the stats cache invalidates when an order is written', async () => {
  const { env, viewer } = await setup();
  const first = mk();
  await env.ORDERS.commit({ puts: orderPuts(first) });
  const q = '/api/inventory/stats?period=7d';
  assert.equal((await get(env, viewer, q)).json.tiles.orders, 1);
  const second = mk();
  await env.ORDERS.commit({ puts: orderPuts(second) }); // not through an order writer: still the cached answer
  assert.equal((await get(env, viewer, q)).json.tiles.orders, 1);
  await changeOrder(env, first.id, r => ({ ...r, fulfilmentStatus: 'CANCELLED' }));
  const r = await get(env, viewer, q);
  assert.equal(r.json.tiles.orders, 1, 'second counts, first is cancelled');
  assert.equal(r.json.tiles.sales, second.totalCents);
});

test('custom ranges over 366 days are 400 invalid-query', async () => {
  const { env, viewer } = await setup();
  for (const q of ['period=custom&from=2025-01-01&to=2026-10-03', 'period=custom', 'period=nope', 'period=custom&from=2026-10-03&to=2026-10-01']) {
    const r = await get(env, viewer, `/api/inventory/stats?${q}`);
    assert.equal(r.status, 400, q);
    assert.equal(r.json.error.code, 'invalid-query', q);
  }
});

const BAR = /<path class="bar" d="M([\d.]+),([\d.]+)V([\d.]+)Q([\d.]+),([\d.]+) ([\d.]+),([\d.]+)H([\d.]+)Q([\d.]+),([\d.]+) ([\d.]+),([\d.]+)V([\d.]+)Z"/g;
const bars = svg => [...svg.matchAll(BAR)].map(m => m.slice(1).map(Number)); // [x, base, y+r, x, y, x+r, y, ...]

test('the bar chart draws one rounded bar per day, proportional, on a baseline, with accessible labels', () => {
  const data = [{ day: '2026-10-01', cents: 10000, orders: 2 }, { day: '2026-10-02', cents: 5000, orders: 1 }, { day: '2026-10-03', cents: 0, orders: 0 }];
  const svg = barChart(data);
  assert.match(svg, /^<svg [^>]*role="group"><title>[^<]*Sales per day[^<]*<\/title>/);
  assert.equal((svg.match(/<g class="slot" role="img" tabindex="0"/g) ?? []).length, 3);
  const b = bars(svg);
  assert.equal(b.length, 2, 'a zero day draws no bar');
  const h = ([, base, , , y]) => base - y;
  assert.ok(Math.abs(h(b[0]) / h(b[1]) - 2) < 0.01, 'heights proportional');
  assert.match(svg, new RegExp(`<line class="base"[^>]* y1="${b[0][1]}"`), 'bars sit on the baseline');
  const labels = [...svg.matchAll(/<g class="slot"[^>]*tabindex="0"[^>]*aria-label="([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(labels, ['1 Oct: $100.00, 2 orders', '2 Oct: $50.00, 1 order', '3 Oct: $0.00, 0 orders']);
  assert.equal((svg.match(/class="gl"/g) ?? []).length, 2, 'recessive grid');
  assert.ok(!/style=/.test(svg));
});

test('bars have 4px rounded tops and 2px gaps', () => {
  const data = Array.from({ length: 10 }, (_, i) => ({ day: `2026-10-${String(i + 1).padStart(2, '0')}`, cents: 1000 * (i + 1), orders: 1 }));
  const b = bars(barChart(data));
  assert.equal(b.length, 10);
  for (const m of b) assert.ok(Math.abs(m[2] - m[4] - 4) < 1e-6 || m[2] - m[4] < 4, 'radius at most 4');
  assert.ok(Math.abs(b[9][2] - b[9][4] - 4) < 1e-6, 'a tall bar has the full 4px');
  for (let i = 1; i < b.length; i++) assert.ok(Math.abs(b[i][0] - b[i - 1][10] - 2) < 0.01, 'next bar starts 2px after the last ends');
});

test('a 366-day range is drawn a week to a bar, with positive widths and a bounded tab-stop count', () => {
  const data = Array.from({ length: 366 }, (_, i) => ({ day: new Date(Date.parse('2025-10-03T00:00:00Z') + i * DAY).toISOString().slice(0, 10), cents: 1000 + i, orders: 1 }));
  const svg = barChart(data);
  const b = bars(svg);
  const slots = [...svg.matchAll(/<g class="slot"[^>]*aria-label="([^"]+)"/g)].map(m => m[1]);
  assert.ok(slots.length <= 60 && slots.length >= 52, `${slots.length} slots`);
  assert.equal(b.length, slots.length);
  for (const m of b) assert.ok(m[10] - m[0] > 1, 'bar has width');
  assert.match(slots[0], /^Week of 29 Sep: /); // 3 Oct 2025 is a Friday: its week starts Mon 29 Sep
  assert.equal(slots.reduce((s, l) => s + Number(l.match(/, (\d+) orders?$/)[1]), 0), 366, 'no day lost');
  assert.equal(bucketed(data.slice(0, 62)).length, 62, 'up to 62 days stay daily');
});

test('an empty or all-zero chart still renders', () => {
  assert.match(barChart([]), /^<svg /);
  assert.match(barChart([{ day: '2026-10-01', cents: 0, orders: 0 }]), /^<svg /);
});
