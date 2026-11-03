import test from 'node:test';
import assert from 'node:assert/strict';
import { call, makeEnv, fakeKV } from './helpers/fake-env.mjs';
import { signIn, ADMIN_TOKEN } from './helpers/staff.mjs';
import { NOW } from './helpers/fixture.mjs';
import { orderPuts } from '../server/lib/orders.js';
import { seal } from '../server/lib/crypto.js';
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
  const { env, owner, viewer } = await setup();
  const paid =mk({ ago: 5 * HOUR }), ready = mk({ ago: 2 * HOUR, payment: 'NOT_COLLECTED', fulfilment: 'READY', loc: 'evincus-store' });
  const old = mk({ ago: 40 * DAY }), yesterday = mk({ ago: DAY });
  const out = [mk({ fulfilment: 'FULFILLED' }), mk({ payment: 'UNPAID' }), mk({ fulfilment: 'CANCELLED' }), mk({ payment: 'PARTIALLY_REFUNDED' })];
  await seed(env, paid, ready, old, yesterday, ...out);
  let reads = [];
  for (const fn of ['get', 'getEntry']) {
    const real = env.ORDERS[fn].bind(env.ORDERS);
    env.ORDERS[fn] = (key, ...a) => { if (key.startsWith('order:')) reads.push(key); return real(key, ...a); };
  }
  // Views and metadata filters read no order; an owner's page then reads only its own rows, for the names.
  const list = async (path, cookie = owner) => {
    reads = [];
    const r = await get(env, cookie, path);
    assert.equal(r.status, 200, path);
    assert.deepEqual(reads.sort(), cookie === owner ? ids(r).map(id => `order:${id}`).sort() : [], path);
    return r;
  };
  const r = await list('/api/inventory/orders');
  assert.deepEqual(ids(r), [ready.id, paid.id, yesterday.id], 'newest first, last 30 days, the open view by default');
  assert.equal(r.json.cursor, null);
  const summary = { id: ready.id, totalCents: 6998, payment: 'NOT_COLLECTED', fulfilment: 'READY', type: 'pickup', locationId: 'evincus-store', units: 2, placedAt: ready.placedAt };
  assert.deepEqual(r.json.orders[0], { ...summary, name: 'Ann L.' });
  assert.deepEqual((await list('/api/inventory/orders', viewer)).json.orders[0], summary, 'viewers get no name');
  assert.deepEqual(ids(await list('/api/inventory/orders?view=open&location=trendy-hats')), [paid.id, yesterday.id]);
  assert.deepEqual(ids(await list('/api/inventory/orders?view=all&payment=UNPAID')), [out[1].id]);
  assert.deepEqual(ids(await list('/api/inventory/orders?view=ready')), [ready.id]);
  assert.deepEqual(ids(await list('/api/inventory/orders?view=awaiting')), [out[1].id]);
  assert.deepEqual(ids(await list('/api/inventory/orders?view=fulfilled', viewer)), [out[0].id]);
  assert.deepEqual(ids(await list('/api/inventory/orders?view=cancelled')), [out[2].id]);
  assert.equal(ids(await list('/api/inventory/orders?view=all', viewer)).length, 7);
  const day = d => new Date(NOW - d * DAY - 5 * HOUR).toISOString().slice(0, 10);
  assert.deepEqual(ids(await list(`/api/inventory/orders?from=${day(41)}&to=${day(39)}`)), [old.id]);
  for (const q of ['view=nope', 'from=2026-13-01', 'to=yesterday', 'cursor=x', 'from=2026-10-03&to=2026-10-01', 'from=2020-01-01'])
    assert.equal((await get(env, owner, `/api/inventory/orders?${q}`)).json.error.code, 'invalid-query', q);
});

test('a list cursor must name a time inside the range, and the walk never starts after `to`', async () => {
  const { env, owner } = await setup();
  const a = mk({ ago: 2 * DAY }), b = mk({ ago: 3 * DAY });
  await seed(env, a, b);
  const at = (from, to, cursor) => get(env, owner, `/api/inventory/orders?view=all&from=${from}&to=${to}&cursor=${encodeURIComponent(cursor)}`);
  for (const cursor of ['9999-12-31T00:00:00Z|x', '2026-13-01T00:00:00Z|x', '2026-09-01T00:00:00.000Z|x']) {
    const r = await at('2026-09-20', '2026-10-03', cursor);
    assert.equal(r.status, 400, cursor);
    assert.equal(r.json.error.code, 'invalid-query', cursor);
  }
  // A cursor at 22:00 Jamaica on `to` is already the next day in UTC: still inside the range, judged by Jamaica day.
  const to = new Date(Date.parse(a.placedAt) - 5 * HOUR).toISOString().slice(0, 10);
  const r = await at('2026-09-20', to, `${new Date(Date.parse(`${to}T00:00:00Z`) + DAY + 3 * HOUR).toISOString()}|EV-z`);
  assert.equal(r.status, 200);
  assert.deepEqual(ids(r), [a.id, b.id]);
});

test('owners see a short customer name on list rows; scrubbed orders show a dash', async () => {
  const { env, owner, viewer } = await setup();
  const one = mk({ customer: { name: 'Tanya Marie Brown', email: 't@x.co', phone: '876 555 0142' } });
  const mono = mk({ ago: 2 * HOUR, customer: { name: 'Prince', email: 'p@x.co', phone: '876 555 0143' } });
  const { customer, payer, notes, ...rest } = mk({ ago: 3 * HOUR });
  await seed(env, one, mono, { ...rest, scrubbedAt: new Date(NOW).toISOString() });
  const rows = (await get(env, owner, '/api/inventory/orders')).json.orders;
  assert.deepEqual(rows.map(o => o.name), ['Tanya B.', 'Prince', '—']);
  const text = JSON.stringify((await get(env, viewer, '/api/inventory/orders')).json);
  assert.ok(!text.includes('"name"') && !text.includes('Tanya'), 'viewers get no name field');
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
  const o0 = mk({ shipto: { line1: '1 Main' }, personal: { x: 1 } });
  const o = { ...o0, events: [...o0.events, { at: new Date(NOW).toISOString(), type: 'refund', by: 'owner@evincus.shop', amountCents: 100, reason: 'Ann at 12 Hope Rd' }] }, other = mk({ customer: { name: 'Bo Kim', email: 'b@x.co', phone: '876 555 0199' }, lineId: 'old-cap' });
  await seed(env, o, other);
  const v = await get(env, viewer, `/api/inventory/orders/${o.id}`);
  assert.equal(v.status, 200);
  for (const f of PERSONAL_FIELDS) assert.equal(f in v.json.order, false, f);
  assert.equal(v.json.order.events.some(e => e.type === 'note'), false);
  assert.deepEqual(v.json.order.events.find(e => e.type === 'refund'), { at: new Date(NOW).toISOString(), type: 'refund', by: 'owner@evincus.shop', amountCents: 100 }, 'no refund reason');
  assert.equal(v.json.order.lines.some(l => 'costCents' in l), false);
  assert.equal(v.json.order.lines[0].sku, 'A-1');
  const text = JSON.stringify(v.json);
  for (const pii of ['Ann Lee', 'ann@example.com', '555 123', 'after 5pm', 'called her', '1 Main', 'Hope Rd'])assert.ok(!text.includes(pii), pii);
  const w = await get(env, owner, `/api/inventory/orders/${o.id}`);
  const e = await env.ORDERS.getEntry(`order:${o.id}`);
  assert.deepEqual({ ...w.json.order, customer: undefined, address: undefined }, { ...JSON.parse(e.value), customer: undefined, address: undefined });
  assert.equal(w.json.order.customer.name, 'Ann Lee');
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
  // An order number is never read as phone digits: 00000777 is inside the second phone's digits.
  await seed(env, mk({ id: 'EV-00000777', customer: { name: 'Dee', email: 'd@x.co', phone: '876 555 0100' } }), mk({ customer: { name: 'Cy', email: 'c@x.co', phone: '+1 000 007 7700' } }));
  assert.deepEqual(ids(await get(env, owner, '/api/inventory/orders?q=EV-00000777')), ['EV-00000777']);

  const { customer, payer, notes, ...rest } = o;
  const scrubbed = { ...rest, id: 'EV-scrubbed', scrubbedAt: new Date(NOW).toISOString() };
  await seed(env, scrubbed);
  const sv = await get(env, owner, '/api/inventory/orders/EV-scrubbed');
  assert.equal(sv.json.scrubbed, true);
  assert.equal(sv.json.order.customer, undefined);
  assert.deepEqual(ids(await get(env, owner, '/api/inventory/orders?q=ann')), [o.id], 'scrubbed orders never match a name');
});

test('owners read sealed orders: row name, search by name or phone, detail; viewers get none of it', async () => {
  const { env, owner, viewer } = await setup();
  const { customer, payer, notes, ...rest } = mk();
  const pii = await seal(env, { customer: { firstName: 'Sam', lastName: 'Reid', email: 'sam@example.com', phone: '876 555 0177' }, address: { line1: '9 Hope Rd', line2: '', city: 'Kingston', region: '', postalCode: '', country: 'JM' }, notes: 'leave at door' });
  const sealed = { ...rest, fulfillment: { type: 'shipping' }, pii };
  const legacy = mk({ customer: { name: 'Bo Kim', email: 'b@x.co', phone: '876 555 0199' } });
  await seed(env, sealed, legacy);
  const rows = (await get(env, owner, '/api/inventory/orders')).json.orders;
  assert.equal(rows.find(r => r.id === sealed.id).name, 'Sam R.');
  assert.deepEqual(ids(await get(env, owner, '/api/inventory/orders?q=sam')), [sealed.id]);
  assert.deepEqual(ids(await get(env, owner, '/api/inventory/orders?q=8765550177')), [sealed.id]);
  assert.deepEqual(ids(await get(env, owner, '/api/inventory/orders?q=bo')), [legacy.id], 'legacy plaintext still matches');
  const d = await get(env, owner, `/api/inventory/orders/${sealed.id}`);
  assert.equal(d.json.order.customer.name, 'Sam Reid');
  assert.equal(d.json.order.notes, 'leave at door');
  assert.equal(d.json.order.address.city, 'Kingston');
  assert.equal('pii' in d.json.order, false);
  const v = await get(env, viewer, `/api/inventory/orders/${sealed.id}`);
  const text = JSON.stringify(v.json);
  for (const s of ['Sam', 'sam@example.com', 'Hope Rd', 'leave at door', '"pii"', '"ct"']) assert.ok(!text.includes(s), s);
  assert.equal((await get(env, viewer, '/api/inventory/orders?q=sam')).status, 403);
});

test('the detail page gets a photo per line from the catalog', async () => {
  const { env, viewer } = await setup();
  const o = mk({ lines: [{ key: KEY, id: 'alpha-tee', name: 'Alpha Tee', color: 'Black, white print', size: 'S', qty: 1, unitCents: 3499 }, { key: 'gone|X|S', id: 'gone', name: 'Gone', color: 'X', size: 'S', qty: 1, unitCents: 100 }] });
  await seed(env, o);
  const r = await get(env, viewer, `/api/inventory/orders/${o.id}`);
  assert.equal(typeof r.json.covers[KEY], 'string');
  assert.equal(r.json.covers['gone|X|S'], null);
});
