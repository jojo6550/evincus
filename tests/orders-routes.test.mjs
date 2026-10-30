import test from 'node:test';
import assert from 'node:assert/strict';
import { call, makeEnv, fakeKV } from './helpers/fake-env.mjs';
import { signIn, ADMIN_TOKEN } from './helpers/staff.mjs';
import { NOW } from './helpers/fixture.mjs';
import { orderPuts } from '../server/lib/orders.js';
import { PERSONAL_FIELDS } from '../server/lib/retention.js';

const HOUR = 3600000, DAY = 24 * HOUR;
const KEY = 'alpha-tee|Black, white print|S';
let seq = 0;
// An order record as checkout writes it; `ago` is how long before NOW it was placed.
const mk = ({ ago = HOUR, payment = 'PAID', fulfilment = 'UNFULFILLED', type = 'pickup', loc = 'trendy-hats', lineId = 'alpha-tee', ...over } = {}) => ({
  id: `EV-${String(++seq).padStart(8, '0')}`, status: 'PLACED', paymentStatus: payment, fulfilmentStatus: fulfilment,
  placedAt: new Date(NOW - ago).toISOString(), stockCommitted: true,
  fulfillment: type === 'pickup' ? { type, location: { id: loc, name: 'TrendyHatz', area: 'Bankhouse Mall' } } : { type },
  lines: [{ key: `${lineId}|Black, white print|S`, id: lineId, name: 'Alpha Tee', color: 'Black, white print', size: 'S', qty: 2, unitCents: 3499, sku: 'A-1', costCents: 1200 }],
  subtotalCents: 6998, totalCents: 6998,
  customer: { name: 'Ann Lee', email: 'ann@example.com', phone: '+1 555 123 4567' },
  payer: { name: 'Ann Lee', email: 'ann@example.com', phone: '+1 555 123 4567', firstName: 'Ann' }, notes: 'after 5pm',
  events: [{ at: new Date(NOW - ago).toISOString(), type: 'placed', by: null }, { at: new Date(NOW).toISOString(), type: 'note', by: 'owner@evincus.shop', text: 'called her' }],
  ...over,
});
const seed = (env, ...records) => env.ORDERS.commit({ puts: records.flatMap(orderPuts) });

async function setup(over) {
  const env = makeEnv({ ADMIN_TOKEN, ...over });
  return { env, owner: await signIn(env), viewer: await signIn(env, 'viewer') };
}
const get = (env, cookie, path) => call('GET', path, { env, headers: { cookie } });
const ids = r => r.json.orders.map(o => o.id);

test('the open view lists paid and not-collected unfulfilled or ready orders from metadata only', async () => {
  const { env, owner } = await setup();
  const paid = mk({ ago: 5 * HOUR }), ready = mk({ ago: 2 * HOUR, payment: 'NOT_COLLECTED', fulfilment: 'READY', loc: 'evincus-store' });
  const old = mk({ ago: 40 * DAY }), yesterday = mk({ ago: DAY });
  const out = [mk({ fulfilment: 'FULFILLED' }), mk({ payment: 'UNPAID' }), mk({ fulfilment: 'CANCELLED' }), mk({ payment: 'PARTIALLY_REFUNDED' })];
  await seed(env, paid, ready, old, yesterday, ...out);
  const reads = [];
  for (const fn of ['get', 'getEntry']) {
    const real = env.ORDERS[fn].bind(env.ORDERS);
    env.ORDERS[fn] = (key, ...a) => { if (key.startsWith('order:')) reads.push(key); return real(key, ...a); };
  }
  const r = await get(env, owner, '/api/inventory/orders');
  assert.equal(r.status, 200);
  assert.deepEqual(ids(r), [ready.id, paid.id, yesterday.id], 'newest first, last 30 days, the open view by default');
  assert.equal(r.json.cursor, null);
  const row = r.json.orders[0];
  assert.deepEqual(row, { id: ready.id, totalCents: 6998, payment: 'NOT_COLLECTED', fulfilment: 'READY', type: 'pickup', locationId: 'evincus-store', units: 2, placedAt: ready.placedAt });
  assert.deepEqual(ids(await get(env, owner, '/api/inventory/orders?view=open&location=trendy-hats')), [paid.id, yesterday.id]);
  assert.deepEqual(ids(await get(env, owner, '/api/inventory/orders?view=all&payment=UNPAID')), [out[1].id]);
  assert.deepEqual(ids(await get(env, owner, '/api/inventory/orders?view=ready')), [ready.id]);
  assert.deepEqual(ids(await get(env, owner, '/api/inventory/orders?view=awaiting')), [out[1].id]);
  assert.deepEqual(ids(await get(env, owner, '/api/inventory/orders?view=fulfilled')), [out[0].id]);
  assert.deepEqual(ids(await get(env, owner, '/api/inventory/orders?view=cancelled')), [out[2].id]);
  assert.equal(ids(await get(env, owner, '/api/inventory/orders?view=all')).length, 7);
  const day = d => new Date(NOW - d * DAY - 5 * HOUR).toISOString().slice(0, 10);
  assert.deepEqual(ids(await get(env, owner, `/api/inventory/orders?from=${day(41)}&to=${day(39)}`)), [old.id]);
  assert.deepEqual(reads, [], 'no order: reads for views and metadata filters');
  for (const q of ['view=nope', 'from=2026-13-01', 'to=yesterday', 'cursor=x', 'from=2026-10-03&to=2026-10-01', 'from=2020-01-01'])
    assert.equal((await get(env, owner, `/api/inventory/orders?${q}`)).json.error.code, 'invalid-query', q);
});

test('order lists past 1000 day keys page with cursor', async () => {
  const { env, owner } = await setup({ ORDERS: fakeKV({ pageSize: 1000 }) });
  // 1003 orders on one Jamaica day (two KV pages for that day alone) and 4 on the day before.
  const many = Array.from({ length: 1003 }, (_, i) => mk({ ago: HOUR + i * 1000 }));
  const before = Array.from({ length: 4 }, (_, i) => mk({ ago: DAY + i * 1000 }));
  for (let i = 0; i < many.length; i += 400) await seed(env, ...many.slice(i, i + 400));
  await seed(env, ...before);
  const seen = [];
  let cursor = null, pages = 0;
  do {
    const r = await get(env, owner, `/api/inventory/orders${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`);
    assert.equal(r.status, 200);
    assert.ok(r.json.orders.length <= 50);
    seen.push(...r.json.orders);
    cursor = r.json.cursor;
    pages++;
  } while (cursor);
  assert.equal(pages, Math.ceil(1007 / 50));
  assert.equal(new Set(seen.map(o => o.id)).size, 1007, 'every order once');
  assert.deepEqual(seen.map(o => o.id), [...many, ...before].map(o => o.id), 'newest first across pages and days');
});

test('viewers get no personal data, cost or notes, and 403 on name search', async () => {
  const { env, owner, viewer } = await setup();
  const o = mk({ shipto: { line1: '1 Main' }, personal: { x: 1 } }), other = mk({ customer: { name: 'Bo Kim', email: 'b@x.co', phone: '876 555 0199' }, lineId: 'old-cap' });
  await seed(env, o, other);
  const v = await get(env, viewer, `/api/inventory/orders/${o.id}`);
  assert.equal(v.status, 200);
  for (const f of PERSONAL_FIELDS) assert.equal(f in v.json.order, false, f);
  assert.equal(v.json.order.events.some(e => e.type === 'note'), false);
  assert.equal(v.json.order.lines.some(l => 'costCents' in l), false);
  assert.equal(v.json.order.lines[0].sku, 'A-1');
  const text = JSON.stringify(v.json);
  for (const pii of ['Ann Lee', 'ann@example.com', '555 123', 'after 5pm', 'called her', '1 Main']) assert.ok(!text.includes(pii), pii);
  const w = await get(env, owner, `/api/inventory/orders/${o.id}`);
  const e = await env.ORDERS.getEntry(`order:${o.id}`);
  assert.deepEqual(w.json.order, JSON.parse(e.value));
  assert.equal(w.json.version, e.version);
  assert.equal(v.json.version, e.version);
  assert.equal(w.json.scrubbed, undefined);
  assert.equal((await get(env, viewer, '/api/inventory/orders/EV-nope')).json.error.code, 'unknown-order');

  const s = await get(env, viewer, '/api/inventory/orders?q=ann');
  assert.equal(s.status, 403);
  assert.equal(s.json.error.code, 'forbidden');
  assert.deepEqual(ids(await get(env, viewer, '/api/inventory/orders?product=old-cap')), [other.id], 'viewers may filter by product');
  assert.deepEqual(ids(await get(env, owner, '/api/inventory/orders?q=ANN')), [o.id]);
  assert.deepEqual(ids(await get(env, owner, '/api/inventory/orders?q=8765550199')), [other.id], 'phone digits, any spacing');
  assert.deepEqual(ids(await get(env, owner, `/api/inventory/orders?q=${o.id.toLowerCase()}`)), [o.id], 'order number');
  assert.deepEqual(ids(await get(env, owner, '/api/inventory/orders?q=bo&product=alpha-tee')), []);

  const { customer, payer, notes, ...rest } = o;
  const scrubbed = { ...rest, id: 'EV-scrubbed', scrubbedAt: new Date(NOW).toISOString() };
  await seed(env, scrubbed);
  const sv = await get(env, owner, '/api/inventory/orders/EV-scrubbed');
  assert.equal(sv.json.scrubbed, true);
  assert.equal(sv.json.order.customer, undefined);
  assert.deepEqual(ids(await get(env, owner, '/api/inventory/orders?q=ann')), [o.id], 'scrubbed orders never match a name');
});

test('the detail page gets a photo per line from the catalog', async () => {
  const { env, viewer } = await setup();
  const o = mk({ lines: [{ key: KEY, id: 'alpha-tee', name: 'Alpha Tee', color: 'Black, white print', size: 'S', qty: 1, unitCents: 3499 }, { key: 'gone|X|S', id: 'gone', name: 'Gone', color: 'X', size: 'S', qty: 1, unitCents: 100 }] });
  await seed(env, o);
  const r = await get(env, viewer, `/api/inventory/orders/${o.id}`);
  assert.equal(typeof r.json.covers[KEY], 'string');
  assert.equal(r.json.covers['gone|X|S'], null);
});
