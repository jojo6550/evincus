import test from 'node:test';
import assert from 'node:assert/strict';
import { call, makeEnv, makeCtx, fakeUpstreams, captureLogs, putStock, stockOf } from './helpers/fake-env.mjs';
import { signIn, post, ADMIN_TOKEN } from './helpers/staff.mjs';
import { FIXTURE, NOW } from './helpers/fixture.mjs';
import { createApp } from '../server/index.js';
import { orderSummary } from '../server/lib/order-flow.js';

const MIN = 60_000;
const KEY = 'alpha-tee|Black, white print|S';
const item = { id: 'alpha-tee', color: 'Black, white print', size: 'S', qty: 2 };
const order = () => ({ checkoutToken: crypto.randomUUID(), items: [item], customer: { name: 'Ann Lee', email: 'ann@example.com', phone: '+1 555 123 4567' }, fulfillment: { type: 'pickup', locationId: 'trendy-hats' }, expectedTotalCents: 6998 });

async function setup(resend) {
  fakeUpstreams({ resend });
  const env = makeEnv({ ADMIN_TOKEN });
  const cookie = await signIn(env);
  const id = (await call('POST', '/api/orders', { body: order(), env })).json.id;
  return { env, cookie, id };
}
const entry = async (env, id) => { const e = await env.ORDERS.getEntry(`order:${id}`); return { order: JSON.parse(e.value), version: e.version }; };
const act = async (env, cookie, id, action, { opId = crypto.randomUUID(), version, headers } = {}) =>
  post(env, cookie, `/api/inventory/orders/${id}/actions`, { opId, version: version === undefined ? (await entry(env, id)).version : version, action }, headers);
const dayMeta = async (env, id) => (await env.ORDERS.list({ prefix: 'day:' })).keys.find(k => k.name.endsWith(id)).metadata;
const adjs = (env, opId) => [...env.ORDERS.store].filter(([k]) => k.startsWith('adj:') && k.includes(opId)).map(([, v]) => JSON.parse(v.value));
const snapshot = env => JSON.stringify([...env.ORDERS.store].filter(([k]) => !k.startsWith('session:')));

async function cron(env, at) {
  const app = createApp({ data: FIXTURE, clock: () => at });
  const ctx = makeCtx();
  await app.scheduled({ cron: '*/15 * * * *', scheduledTime: at }, env, ctx);
  await ctx.settle();
}

// Runs `before` once, just ahead of the first commit that carries an op: check (the action's commit).
function beforeActionCommit(env, before) {
  const commit = env.ORDERS.commit.bind(env.ORDERS);
  let once = true;
  env.ORDERS.commit = async args => {
    if (once && args.checks?.some(ch => ch.key.startsWith('op:'))) { once = false; await before(); }
    return commit(args);
  };
}

test('an email retry landing after an owner action keeps the action', async () => {
  let failing = true;
  const { env, cookie, id } = await setup({ fail: () => failing });
  assert.equal((await entry(env, id)).order.email.customer, 'failed');
  failing = false;
  // The owner marks the order ready while the retry is sending, after it read the record.
  const send = globalThis.fetch;
  let r;
  globalThis.fetch = async (...a) => { r ??= await act(env, cookie, id, { type: 'ready' }); return send(...a); };
  await cron(env, NOW + 15 * MIN);
  assert.equal(r.status, 200);
  const { order: o } = await entry(env, id);
  assert.equal(o.fulfilmentStatus, 'READY');
  assert.equal(o.email.customer, 'sent');
  assert.equal((await dayMeta(env, id)).fulfilment, 'READY');
});

test('an action with a stale version is 409 order-changed and changes nothing', async () => {
  const { env, cookie, id } = await setup();
  const cur = await entry(env, id);
  const before = snapshot(env);
  const r = await act(env, cookie, id, { type: 'ready' }, { version: '0'.repeat(20) });
  assert.equal(r.status, 409);
  assert.equal(r.json.error.code, 'order-changed');
  assert.deepEqual(r.json.error.current, cur.order);
  assert.equal(r.json.error.version, cur.version);
  assert.equal(snapshot(env), before);
});

test('a repeated opId applies an action once', async () => {
  const { env, cookie, id } = await setup();
  const opId = crypto.randomUUID();
  const { version } = await entry(env, id);
  const [a, b] = await Promise.all([act(env, cookie, id, { type: 'ready' }, { opId, version }), act(env, cookie, id, { type: 'ready' }, { opId, version })]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.deepEqual(a.json, b.json);
  const now = await entry(env, id);
  assert.deepEqual(a.json, now);
  assert.equal(now.order.events.filter(ev => ev.type === 'ready').length, 1);
  // A later retry with the now-stale version still replays.
  const c = await act(env, cookie, id, { type: 'ready' }, { opId, version });
  assert.equal(c.status, 200);
  assert.deepEqual(c.json, now);
});

test('fulfilling an order moves stock and writes adj records with the order id', async () => {
  const { env, cookie, id } = await setup();
  assert.deepEqual(stockOf(env, KEY), { onHand: 10, committed: 2 });
  const opId = crypto.randomUUID();
  const logs = captureLogs();
  let r;
  try { r = await act(env, cookie, id, { type: 'fulfilled' }, { opId }); } finally { logs.restore(); }
  assert.equal(r.status, 200);
  assert.equal(r.json.order.fulfilmentStatus, 'FULFILLED');
  assert.deepEqual(r.json, await entry(env, id));
  assert.deepEqual(stockOf(env, KEY), { onHand: 8, committed: 0 });
  const [adj, ...more] = adjs(env, opId);
  assert.equal(more.length, 0);
  assert.deepEqual(adj, { key: KEY, onHand: -2, committed: -2, reason: 'sold', note: '', by: 'owner@evincus.shop', at: new Date(NOW).toISOString(), orderId: id });
  const line = logs.lines.find(l => l.event === 'order.fulfilled');
  assert.equal(line.orderId, id);
  assert.ok(line.account); // log redaction masks the address itself
  const all = JSON.stringify(logs.lines);
  for (const pii of ['ann@example.com', 'Ann Lee', '+1 555 123 4567']) assert.ok(!all.includes(pii), pii);
});

test('actions on orders placed before inventory never touch stock', async () => {
  const { env, cookie } = await setup();
  const id = 'EV-legacy';
  await env.ORDERS.put(`order:${id}`, JSON.stringify({
    id, status: 'PLACED', paymentStatus: 'NOT_COLLECTED', placedAt: new Date(NOW).toISOString(),
    lines: [{ key: KEY, id: 'alpha-tee', name: 'Alpha Tee', color: 'Black, white print', size: 'S', qty: 2, unitCents: 3499 }],
    subtotalCents: 6998, totalCents: 6998, fulfillment: { type: 'pickup', location: { id: 'trendy-hats' } },
    email: { customer: 'sent', owner: 'daily-summary', attempts: 1 },
  }));
  const stock = (await env.ORDERS.getEntry('stock:alpha-tee')).version;
  assert.equal((await act(env, cookie, id, { type: 'ready' })).status, 200);
  const r = await act(env, cookie, id, { type: 'cancel', restock: true });
  assert.equal(r.status, 200);
  assert.equal(r.json.order.fulfilmentStatus, 'CANCELLED');
  assert.equal((await env.ORDERS.getEntry('stock:alpha-tee')).version, stock);
  assert.equal([...env.ORDERS.store.keys()].filter(k => k.startsWith('adj:') && !k.includes(':EV-')).length, 0);
  assert.equal((await dayMeta(env, id)).fulfilment, 'CANCELLED');
});

test('day index metadata follows every order change', async () => {
  const { env, cookie, id } = await setup();
  assert.deepEqual(await dayMeta(env, id), orderSummary((await entry(env, id)).order));
  assert.equal((await dayMeta(env, id)).fulfilment, 'UNFULFILLED');
  await act(env, cookie, id, { type: 'ready' });
  assert.deepEqual(await dayMeta(env, id), orderSummary((await entry(env, id)).order));
  assert.equal((await dayMeta(env, id)).fulfilment, 'READY');
  await act(env, cookie, id, { type: 'note', text: 'Called, coming Friday' });
  await act(env, cookie, id, { type: 'cancel', restock: true });
  assert.deepEqual(await dayMeta(env, id), orderSummary((await entry(env, id)).order));
  assert.equal((await dayMeta(env, id)).fulfilment, 'CANCELLED');
  assert.deepEqual(stockOf(env, KEY), { onHand: 10, committed: 0 });
});

test('placement records the fulfilment status and a placed event', async () => {
  const { env, id } = await setup();
  const { order: o } = await entry(env, id);
  assert.equal(o.fulfilmentStatus, 'UNFULFILLED');
  assert.deepEqual(o.events, [{ at: new Date(NOW).toISOString(), type: 'placed', by: null }]);
});

test('a lost round re-reads stock and applies onto the new numbers', async () => {
  const { env, cookie, id } = await setup();
  const opId = crypto.randomUUID();
  beforeActionCommit(env, () => putStock(env, KEY, 15, 2)); // a delivery recorded meanwhile
  const r = await act(env, cookie, id, { type: 'fulfilled' }, { opId });
  assert.equal(r.status, 200);
  assert.deepEqual(stockOf(env, KEY), { onHand: 13, committed: 0 });
  assert.equal(adjs(env, opId).length, 1);
});

test('a lost round against a changed order is order-changed, not a re-apply', async () => {
  const { env, cookie, id } = await setup();
  const opId = crypto.randomUUID();
  beforeActionCommit(env, async () => {
    const { order: o } = await entry(env, id);
    await env.ORDERS.put(`order:${id}`, JSON.stringify({ ...o, notes: 'changed' }));
  });
  const r = await act(env, cookie, id, { type: 'fulfilled' }, { opId });
  assert.equal(r.status, 409);
  assert.equal(r.json.error.code, 'order-changed');
  assert.equal(r.json.error.current.notes, 'changed');
  assert.deepEqual(stockOf(env, KEY), { onHand: 10, committed: 2 });
  assert.equal(adjs(env, opId).length, 0);
  assert.equal(env.ORDERS.store.has(`op:${opId}`), false);
});

// Each refusal leaves the store exactly as it was.
async function refused(env, cookie, id, action, code) {
  const before = snapshot(env);
  const r = await act(env, cookie, id, action);
  assert.equal(r.status, 409);
  assert.equal(r.json.error.code, code);
  assert.equal(snapshot(env), before);
  return r;
}

test('fulfilling more than is on hand is stock-short with the key, and nothing is written', async () => {
  const { env, cookie, id } = await setup();
  await putStock(env, KEY, 1, 2); // an oversold continueSelling variant
  const r = await refused(env, cookie, id, { type: 'fulfilled' }, 'stock-short');
  assert.equal(r.json.error.key, KEY);
  assert.match(r.json.error.message, /Record the stock you received/);
});

test('a movement for a variant missing from the stock doc is variant-gone with the key', async () => {
  const { env, cookie, id } = await setup();
  await env.ORDERS.put('stock:alpha-tee', JSON.stringify({ 'White|S': { onHand: 1, committed: 0 } }));
  const r = await refused(env, cookie, id, { type: 'cancel', restock: false }, 'variant-gone');
  assert.equal(r.json.error.key, KEY);
  assert.deepEqual(JSON.parse(env.ORDERS.store.get('stock:alpha-tee').value), { 'White|S': { onHand: 1, committed: 0 } });
});

test('a movement taking Committed below zero is stock-mismatch, logged at error level', async () => {
  const { env, cookie, id } = await setup();
  await putStock(env, KEY, 10, 0); // committed lost: corrupt data
  const logs = captureLogs();
  let r;
  try { r = await refused(env, cookie, id, { type: 'fulfilled' }, 'stock-mismatch'); } finally { logs.restore(); }
  assert.equal(r.json.error.key, KEY);
  const line = logs.lines.find(l => l.event === 'order.stock_mismatch');
  assert.equal(line.level, 'error');
  assert.equal(line.orderId, id);
  assert.equal(line.key, KEY);
});

test('an order moving more products than one commit can check is refused before any write', async () => {
  const { env, cookie } = await setup();
  const id = 'EV-wide';
  const lines = Array.from({ length: 9 }, (_, i) => ({ key: `p${i}|Black|M`, id: `p${i}`, name: 'P', color: 'Black', size: 'M', qty: 1, unitCents: 100 }));
  await env.ORDERS.put(`order:${id}`, JSON.stringify({ id, status: 'PLACED', paymentStatus: 'NOT_COLLECTED', placedAt: new Date(NOW).toISOString(), stockCommitted: true, lines, subtotalCents: 900, totalCents: 900, fulfillment: { type: 'pickup', location: { id: 'trendy-hats' } } }));
  const before = snapshot(env);
  const logs = captureLogs();
  let r;
  try { r = await act(env, cookie, id, { type: 'fulfilled' }); } finally { logs.restore(); }
  assert.equal(r.status, 500);
  assert.ok(logs.lines.some(l => l.event === 'unhandled' && /one commit fits 8/.test(l.message)));
  env.ORDERS.store.delete('alert:unhandled'); // the 500's alert throttle, not an order write
  assert.equal(snapshot(env), before);
});

test('replaying an opId against another order is op-reused', async () => {
  const { env, cookie, id } = await setup();
  const other = (await call('POST', '/api/orders', { body: order(), env })).json.id;
  const opId = crypto.randomUUID();
  assert.equal((await act(env, cookie, id, { type: 'ready' }, { opId })).status, 200);
  const r = await act(env, cookie, other, { type: 'ready' }, { opId });
  assert.equal(r.status, 409);
  assert.equal(r.json.error.code, 'op-reused');
  assert.equal((await entry(env, other)).order.fulfilmentStatus, 'UNFULFILLED');
});

test('a refund moves stock, writes adj records and updates the order end to end', async () => {
  const { env, cookie, id } = await setup();
  const { order: o } = await entry(env, id);
  await env.ORDERS.put(`order:${id}`, JSON.stringify({ ...o, paymentStatus: 'PAID' })); // as a paid checkout will place it
  const opId = crypto.randomUUID();
  const logs = captureLogs();
  let r;
  try { r = await act(env, cookie, id, { type: 'refund', lines: [{ key: KEY, qty: 1 }], amountCents: 3499, restock: true, reason: 'Wrong size' }, { opId }); } finally { logs.restore(); }
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, await entry(env, id));
  const after = r.json.order;
  assert.equal(after.paymentStatus, 'PARTIALLY_REFUNDED');
  assert.equal(after.refundedCents, 3499);
  assert.deepEqual(after.refundedQty, { [KEY]: 1 });
  assert.deepEqual(stockOf(env, KEY), { onHand: 10, committed: 1 });
  assert.deepEqual(adjs(env, opId), [{ key: KEY, onHand: 0, committed: -1, reason: 'refunded', note: '', by: 'owner@evincus.shop', at: new Date(NOW).toISOString(), orderId: id }]);
  assert.equal((await dayMeta(env, id)).units, 1);
  assert.equal((await dayMeta(env, id)).payment, 'PARTIALLY_REFUNDED');
  assert.ok(logs.lines.some(l => l.event === 'order.refunded' && l.orderId === id && l.account));
});

test('a viewer gets 403 and the order is unchanged', async () => {
  const { env, id } = await setup();
  const viewer = await signIn(env, 'viewer');
  const before = snapshot(env);
  const r = await act(env, viewer, id, { type: 'ready' });
  assert.equal(r.status, 403);
  assert.equal(r.json.error.code, 'forbidden');
  assert.equal(snapshot(env), before);
});

test('a cross-origin write is refused', async () => {
  const { env, cookie, id } = await setup();
  const before = snapshot(env);
  const r = await act(env, cookie, id, { type: 'ready' }, { headers: { origin: 'https://evil.test' } });
  assert.equal(r.status, 403);
  assert.equal(r.json.error.code, 'bad-origin');
  assert.equal(snapshot(env), before);
});

test('an opId used by another kind of write is op-reused', async () => {
  const { env, cookie, id } = await setup();
  const opId = crypto.randomUUID();
  await env.ORDERS.put(`op:${opId}`, JSON.stringify({ kind: 'stock', result: { stock: {} } }));
  const r = await act(env, cookie, id, { type: 'ready' }, { opId });
  assert.equal(r.status, 409);
  assert.equal(r.json.error.code, 'op-reused');
  assert.equal((await entry(env, id)).order.fulfilmentStatus, 'UNFULFILLED');
});

test('an unknown order is 404 and a bad opId is invalid-action', async () => {
  const { env, cookie, id } = await setup();
  assert.equal((await post(env, cookie, '/api/inventory/orders/EV-nope/actions', { opId: crypto.randomUUID(), version: '1', action: { type: 'ready' } })).json.error.code, 'unknown-order');
  assert.equal((await act(env, cookie, id, { type: 'ready' }, { opId: 'x' })).json.error.code, 'invalid-action');
});
