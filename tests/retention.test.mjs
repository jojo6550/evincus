import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, makeCtx, fakeUpstreams, call, captureLogs } from './helpers/fake-env.mjs';
import { FIXTURE } from './helpers/fixture.mjs';
import { createApp } from '../server/index.js';
import { scrubOrders, dropOrderTtls, runRetention } from '../server/lib/retention.js';
import { dayKey, orderKey, changeOrder } from '../server/lib/orders.js';
import { orderSummary } from '../server/lib/order-flow.js';

const DAY = 86_400_000;
const NOW = Date.parse('2028-10-03T12:00:00Z');
const base = (id, placedAt) => ({
  id, placedAt, paymentStatus: 'unpaid', status: 'placed', totalCents: 6998, subtotalCents: 6998,
  customer: { name: 'Ann', email: 'a@x.com', phone: '1' }, payer: { name: 'Ann', email: 'a@x.com' }, notes: 'ring bell',
  shipping: { line1: 'x' }, personal: 'blob', fulfillment: { type: 'pickup', location: { id: 'l', name: 'L' } },
  lines: [{ key: 'p|a|S', name: 'Tee', qty: 2, unitCents: 3499 }], refunds: [{ cents: 100 }], events: [{ type: 'placed', by: 'staff@evincus.shop' }],
});
const seed = (env, r, opts = {}) => {
  env.ORDERS.store.set(orderKey(r.id), { value: JSON.stringify(r), opts });
  env.ORDERS.store.set(dayKey(r), { value: '', opts: { ...opts, metadata: orderSummary(r) } });
};
const read = (env, id) => JSON.parse(env.ORDERS.store.get(orderKey(id)).value);
const iso = ms => new Date(ms).toISOString();
const smallPages = env => { env.ORDERS.list = (list => args => list({ ...args, limit: 2 }))(env.ORDERS.list.bind(env.ORDERS)); };

async function cron(env, at) {
  const ctx = makeCtx();
  await createApp({ data: FIXTURE, clock: () => at }).scheduled({}, env, ctx);
  await ctx.settle();
}

test('orders placed over 2 years ago lose only personal fields, once', async () => {
  const env = makeEnv();
  seed(env, base('EV-OLD', iso(NOW - 731 * DAY)));
  assert.equal(await scrubOrders(env, new Date(NOW)), 1);
  const r = read(env, 'EV-OLD');
  for (const f of ['customer', 'payer', 'notes', 'shipping', 'personal']) assert.ok(!(f in r), f);
  assert.equal(r.scrubbedAt, iso(NOW));
  assert.equal(r.totalCents, 6998);
  assert.deepEqual(r.lines, base('x', '').lines);
  assert.deepEqual(r.refunds, [{ cents: 100 }]);
  assert.equal(r.events[0].by, 'staff@evincus.shop');
  const before = JSON.stringify([...env.ORDERS.store]);
  assert.equal(await scrubOrders(env, new Date(NOW + DAY)), 0);
  assert.equal(JSON.stringify([...env.ORDERS.store]), before);
});

test('orders 2 years old minus a day are untouched', async () => {
  const env = makeEnv();
  seed(env, base('EV-NEW', iso(NOW - 729 * DAY)));
  assert.equal(await scrubOrders(env, new Date(NOW)), 0);
  assert.equal(read(env, 'EV-NEW').customer.name, 'Ann');
});

test('a version clash during the scrub retries and keeps the concurrent change', async () => {
  const env = makeEnv();
  seed(env, base('EV-OLD', iso(NOW - 800 * DAY)));
  const commit = env.ORDERS.commit.bind(env.ORDERS);
  let once = true;
  env.ORDERS.commit = async args => {
    if (once) { once = false; await changeOrder(env, 'EV-OLD', r => ({ ...r, paymentStatus: 'paid' })); }
    return commit(args);
  };
  assert.equal(await scrubOrders(env, new Date(NOW)), 1);
  const r = read(env, 'EV-OLD');
  assert.equal(r.paymentStatus, 'paid');
  assert.ok(r.scrubbedAt && !r.customer);
});

test('a deadline stops the scrub after a page and the next run resumes', async () => {
  const env = makeEnv();
  smallPages(env);
  for (let i = 0; i < 5; i++) seed(env, base(`EV-${i}`, iso(NOW - (900 - i) * DAY)));
  assert.equal(await scrubOrders(env, new Date(NOW), { deadline: 0 }), 2);
  assert.ok(env.ORDERS.store.has('retention:scrub-cursor'));
  assert.equal(await scrubOrders(env, new Date(NOW), { deadline: Infinity }), 3);
  for (let i = 0; i < 5; i++) assert.ok(read(env, `EV-${i}`).scrubbedAt);
});

test('the TTL rewrite removes order and day TTLs, resumes across runs and then stops', async () => {
  const env = makeEnv();
  smallPages(env);
  for (let i = 0; i < 5; i++) seed(env, base(`EV-${i}`, iso(NOW - i * DAY)), { expirationTtl: 63072000 });
  const ttls = () => [...env.ORDERS.store].filter(([k]) => /^(order|day):/.test(k)).map(([, v]) => v.opts.expirationTtl);
  assert.equal(await dropOrderTtls(env, { deadline: 0 }), false);
  assert.ok(ttls().some(Boolean) && ttls().some(t => !t));
  assert.ok(!env.ORDERS.store.has('retention:ttl-done'));
  while (!(await dropOrderTtls(env, { deadline: 0 })));
  assert.ok(ttls().every(t => t === undefined));
  assert.equal(env.ORDERS.store.get(dayKey(base('EV-0', iso(NOW)))).opts.metadata.totalCents, 6998);
  assert.ok(env.ORDERS.store.has('retention:ttl-done'));
  seed(env, base('EV-9', iso(NOW)), { expirationTtl: 5 });
  assert.equal(await dropOrderTtls(env), true);
  assert.equal(env.ORDERS.store.get(orderKey('EV-9')).opts.expirationTtl, 5); // never runs again
});

test('the scheduled run is once per Jamaica day, and a failing job is logged', async () => {
  const env = makeEnv();
  seed(env, base('EV-OLD', iso(NOW - 800 * DAY)));
  await cron(env, NOW);
  assert.ok(read(env, 'EV-OLD').scrubbedAt);
  assert.ok(env.ORDERS.store.has('retention:2028-10-03'));
  env.ORDERS.store.delete('retention:2028-10-03');
  env.ORDERS.store.delete('retention:ttl-done');
  env.ORDERS.list = async () => { throw new Error('list down'); };
  const logs = captureLogs();
  try { await cron(env, NOW); } finally { logs.restore(); }
  assert.ok(logs.lines.some(l => JSON.stringify(l).includes('retention.failed')));
  assert.ok(!env.ORDERS.store.has('retention:2028-10-03'));
});

test('new orders are stored without a TTL; submissions keep theirs', async () => {
  fakeUpstreams();
  const env = makeEnv();
  const item = { id: 'alpha-tee', color: 'Black, white print', size: 'S', qty: 1 };
  const res = await call('POST', '/api/orders', { env, body: { checkoutToken: crypto.randomUUID(), items: [item], customer: { name: 'Ann Lee', email: 'ann@example.com', phone: '+1 555 123 4567' }, fulfillment: { type: 'pickup', locationId: 'trendy-hats' }, expectedTotalCents: 3499 } });
  assert.equal(res.status, 201, res.text);
  const ttl = prefix => [...env.ORDERS.store].filter(([k]) => k.startsWith(prefix)).map(([, v]) => v.opts.expirationTtl);
  assert.deepEqual(ttl('order:'), [undefined]);
  assert.deepEqual(ttl('day:'), [undefined]);
  assert.deepEqual(ttl('submission:'), [63072000]);
});

const spy = () => { const errors = []; return { errors, error: (e, f) => errors.push([e, f]) }; };

test('an orphan day key is skipped and later orders are still scrubbed', async () => {
  const env = makeEnv();
  seed(env, base('EV-A', iso(NOW - 900 * DAY)));
  env.ORDERS.store.delete(orderKey('EV-A'));
  seed(env, base('EV-B', iso(NOW - 800 * DAY)));
  const log = spy();
  assert.equal(await scrubOrders(env, new Date(NOW), { log }), 1);
  assert.ok(read(env, 'EV-B').scrubbedAt);
  assert.deepEqual(log.errors, []);
});

test('a corrupt order is logged by id and later orders are still scrubbed', async () => {
  const env = makeEnv();
  seed(env, base('EV-A', iso(NOW - 900 * DAY)));
  env.ORDERS.store.get(orderKey('EV-A')).value = '{not json';
  seed(env, base('EV-B', iso(NOW - 800 * DAY)));
  const log = spy();
  assert.equal(await scrubOrders(env, new Date(NOW), { log }), 1);
  assert.ok(read(env, 'EV-B').scrubbedAt);
  assert.equal(log.errors.length, 1);
  assert.equal(log.errors[0][0], 'retention.order_failed');
  assert.deepEqual(Object.keys(log.errors[0][1]).sort(), ['message', 'orderId']);
  assert.equal(log.errors[0][1].orderId, 'EV-A');
});

test('a day key without metadata does not stop the walk', async () => {
  const env = makeEnv();
  seed(env, base('EV-A', iso(NOW - 900 * DAY)));
  delete env.ORDERS.store.get(dayKey(base('EV-A', iso(NOW - 900 * DAY)))).opts.metadata;
  seed(env, base('EV-B', iso(NOW - 800 * DAY)));
  assert.equal(await scrubOrders(env, new Date(NOW)), 2);
  assert.ok(read(env, 'EV-A').scrubbedAt && read(env, 'EV-B').scrubbedAt);
});

test('one job failing does not stop the other', async () => {
  const env = makeEnv();
  seed(env, base('EV-OLD', iso(NOW - 800 * DAY)));
  env.ORDERS.failGets = k => k === 'retention:ttl-cursor';
  const errors = [];
  const { done, failed } = await runRetention(env, { now: new Date(NOW), deadline: Infinity, log: { error: e => errors.push(e) } });
  assert.deepEqual([done, failed, errors], [false, true, ['retention.failed']]);
  assert.ok(read(env, 'EV-OLD').scrubbedAt);
});

test('an order that fails once is scrubbed on the next run; scrubbed orders cost no order reads', async () => {
  const env = makeEnv();
  seed(env, base('EV-A', iso(NOW - 900 * DAY)));
  seed(env, base('EV-B', iso(NOW - 800 * DAY)));
  env.ORDERS.failPuts = k => k === orderKey('EV-A');
  const log = spy();
  assert.equal(await scrubOrders(env, new Date(NOW), { log }), 1);
  assert.deepEqual(log.errors.map(e => [e[0], e[1].orderId]), [['retention.order_failed', 'EV-A']]);
  assert.ok(read(env, 'EV-A').customer);
  env.ORDERS.failPuts = null;
  const reads = [];
  for (const m of ['get', 'getEntry']) { const f = env.ORDERS[m].bind(env.ORDERS); env.ORDERS[m] = k => { reads.push(k); return f(k); }; }
  assert.equal(await scrubOrders(env, new Date(NOW + DAY), { log }), 1);
  assert.ok(read(env, 'EV-A').scrubbedAt);
  assert.ok(!reads.includes(orderKey('EV-B')));
  reads.length = 0;
  assert.equal(await scrubOrders(env, new Date(NOW + 2 * DAY)), 0);
  assert.ok(!reads.some(k => k.startsWith('order:')));
});

test('the 730-day boundary is exact', async () => {
  const env = makeEnv();
  seed(env, base('EV-EDGE', iso(NOW - 730 * DAY)));
  seed(env, base('EV-PAST', iso(NOW - 730 * DAY - 1)));
  assert.equal(await scrubOrders(env, new Date(NOW)), 1);
  assert.ok(read(env, 'EV-PAST').scrubbedAt);
  assert.ok(!read(env, 'EV-EDGE').scrubbedAt);
});
