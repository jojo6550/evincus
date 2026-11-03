import test from 'node:test';
import assert from 'node:assert/strict';
import { call, makeEnv, fakeUpstreams, putStock, stockOf } from './helpers/fake-env.mjs';
import { NOW } from './helpers/fixture.mjs';
import { WIPAY, payOrder } from './helpers/pay.mjs';

import { createHash } from 'node:crypto';
import { releaseHold, releaseExpiredHolds, sweepUnpaid, recommit, redriveLate } from '../server/lib/holds.js';
import { orderAction, UNPAID_TTL } from '../server/lib/orders.js';
import { orderSummary } from '../server/lib/order-flow.js';
import { formatTotal } from '../server/lib/wipay.js';
const SHIRT = 'alpha-tee|Black, white print|S';
const body = (qty = 2) => ({ checkoutToken: crypto.randomUUID(), items: [{ id: 'alpha-tee', color: 'Black, white print', size: 'S', qty }], customer: { firstName: 'Ann', lastName: 'Lee', email: 'ann@example.com' }, fulfillment: { type: 'pickup', locationId: 'trendy-hats' }, expectedTotalCents: qty === 2 ? 8437 : 4218 });
const place = (env, b, clock = () => NOW) => call('POST', '/api/orders', { body: b, env, clock });
const order = (env, id) => JSON.parse(env.ORDERS.store.get(`order:${id}`).value);
const holds = env => [...env.ORDERS.store.keys()].filter(k => k.startsWith('hold:'));

test('two shoppers, not enough for both: the loser is bag-changed with what is left', async () => {
  fakeUpstreams();
  const env = makeEnv(); putStock(env, SHIRT, 3, 0);
  const [a, b] = await Promise.all([place(env, body()), place(env, body())]);
  assert.deepEqual([a.status, b.status].sort(), [201, 409]);
  const loser = [a, b].find(r => r.status === 409).json.error;
  assert.equal(loser.code, 'bag-changed');
  assert.deepEqual([loser.lines[0].status, loser.lines[0].available], ['insufficient-stock', 1]);
  assert.equal(stockOf(env, SHIRT).committed, 2);
  assert.equal(holds(env).length, 1);
});

test('a retried checkout holds its stock once', async () => {
  fakeUpstreams();
  const env = makeEnv(); const b = body();
  await Promise.all([place(env, b), place(env, b)]);
  await place(env, b);
  assert.equal(stockOf(env, SHIRT).committed, 2);
  assert.equal(holds(env).length, 1);
});

test('payment clears the hold and keeps the stock committed; paying at minute 14 does not extend it', async () => {
  fakeUpstreams();
  const env = makeEnv(WIPAY);
  const { id } = (await place(env, body())).json;
  const until = order(env, id).holdUntil;
  await call('POST', `/api/orders/${id}/pay`, { body: {}, env, clock: () => NOW + 14 * 60000 });
  assert.equal(order(env, id).holdUntil, until);
  assert.equal(holds(env).length, 1);
  await payOrder(env, id, { clock: () => NOW + 14 * 60000 });
  assert.equal(order(env, id).holdUntil, undefined);
  assert.deepEqual(holds(env), []);
  assert.equal(stockOf(env, SHIRT).committed, 2);
});

// ---- Task 14: release, sweep, late payments ----

const MIN = 60000, DAY = 86400000;
const at = ms => new Date(ms);
const quiet = { info() {}, warn() {}, error() {} };
const cron = (env, now) => ({ env, now: at(now), log: quiet, reqId: 'cron-test', waitUntil() {}, deadline: Date.now() + 30000 });
const adjsFor = (env, id) => [...env.ORDERS.store].filter(([k, v]) => k.startsWith('adj:') && JSON.parse(v.value).orderId === id).map(([, v]) => JSON.parse(v.value));
const ownerMails = up => up.emails.filter(e => e.to[0] === 'owner@evincus.shop');
async function setupHeld({ onHand = 10, clock = NOW } = {}) {
  const up = fakeUpstreams();
  const env = makeEnv(WIPAY); putStock(env, SHIRT, onHand, 0);
  const r = await place(env, body(), () => clock);
  assert.equal(r.status, 201, r.text);
  return { up, env, id: r.json.id };
}
// Starts a payment and returns the signed success redirect for it.
async function startPay(env, id, now) {
  await call('POST', `/api/orders/${id}/pay`, { body: {}, env, clock: () => now });
  const aid = order(env, id).attemptId;
  const txn = `SB-12-1-${aid}-20261024120000`;
  const total = formatTotal(order(env, id).totalCents);
  return `/api/payments/wipay/return?status=success&transaction_id=${txn}&order_id=${aid}&total=${total}&currency=USD&hash=${createHash('md5').update(txn + total + '123').digest('hex')}`;
}
const back = (env, url, now) => call('GET', url, { env, clock: () => now });
const act = async (env, id, action, now) => {
  const e = await env.ORDERS.getEntry(`order:${id}`);
  return orderAction(env, id, { opId: crypto.randomUUID(), version: e.version, action }, { by: 'owner@evincus.shop', now: at(now) });
};

test('releaseHold after expiry returns the stock, once, with an event and an adj per line', async () => {
  const { env, id } = await setupHeld();
  assert.equal(await releaseHold(env, id, { now: at(NOW + 14 * MIN) }), 'not-expired');
  assert.equal(await releaseHold(env, id, { now: at(NOW + 16 * MIN) }), 'released');
  const o = order(env, id);
  assert.equal(o.stockCommitted, false);
  assert.equal(o.holdUntil, undefined);
  assert.equal(o.events.filter(e => e.type === 'hold-released').length, 1);
  assert.equal(stockOf(env, SHIRT).committed, 0);
  assert.deepEqual(holds(env), []);
  assert.deepEqual(adjsFor(env, id).filter(a => a.reason === 'hold-released').map(a => a.committed), [-2]);
  assert.equal(await releaseHold(env, id, { now: at(NOW + 17 * MIN) }), 'not-expired');
  await Promise.all([releaseHold(env, id, { now: at(NOW + 18 * MIN) }), releaseHold(env, id, { now: at(NOW + 18 * MIN) })]);
  assert.equal(stockOf(env, SHIRT).committed, 0);
});

test('two releases at once move stock once', async () => {
  const { env, id } = await setupHeld();
  const rs = await Promise.all([releaseHold(env, id, { now: at(NOW + 16 * MIN) }), releaseHold(env, id, { now: at(NOW + 16 * MIN) })]);
  assert.deepEqual(rs.sort(), ['not-expired', 'released']);
  assert.equal(stockOf(env, SHIRT).committed, 0);
});

test('releaseHold on a paid order is paid and changes nothing', async () => {
  const { env, id } = await setupHeld();
  await back(env, await startPay(env, id, NOW + MIN), NOW + 2 * MIN);
  assert.equal(await releaseHold(env, id, { now: at(NOW + 16 * MIN) }), 'paid');
  assert.equal(stockOf(env, SHIRT).committed, 2);
});

test('a release racing a payment ends consistent: paid, stock committed exactly once', async () => {
  for (let i = 0; i < 5; i++) {
    const { env, id } = await setupHeld();
    const url = await startPay(env, id, NOW + MIN);
    await Promise.all([back(env, url, NOW + 16 * MIN), releaseHold(env, id, { now: at(NOW + 16 * MIN) })]);
    const o = order(env, id);
    assert.equal(o.paymentStatus, 'PAID');
    assert.equal(o.stockCommitted, true);
    assert.equal(stockOf(env, SHIRT).committed, 2);
  }
});

test('cancel and expiry release stock once, in either order', async () => {
  for (const first of ['cancel', 'release']) {
    const { env, id } = await setupHeld();
    const cancel = () => act(env, id, { type: 'cancel', restock: true }, NOW + 16 * MIN);
    const release = () => releaseHold(env, id, { now: at(NOW + 16 * MIN) });
    if (first === 'cancel') { await cancel(); assert.equal(await release(), 'cancelled'); }
    else { await release(); await cancel(); }
    assert.equal(stockOf(env, SHIRT).committed, 0, first);
    assert.deepEqual(holds(env), [], first);
    assert.equal(order(env, id).stockCommitted, false);
  }
});

test('releaseExpiredHolds takes 50 a run and leaves the rest for the next', async () => {
  fakeUpstreams();
  const env = makeEnv(); putStock(env, SHIRT, 100, 0);
  for (let i = 0; i < 60; i++) assert.equal((await place(env, body(1), () => NOW + i)).status, 201);
  assert.equal(await releaseExpiredHolds(env, at(NOW + 20 * MIN)), 50);
  assert.equal(holds(env).length, 10);
  assert.equal(await releaseExpiredHolds(env, at(NOW + 20 * MIN)), 10);
  assert.equal(stockOf(env, SHIRT).committed, 0);
});

test('a checkout short of stock frees an expired hold on the last unit; an unexpired hold stays', async () => {
  fakeUpstreams();
  const env = makeEnv(); putStock(env, SHIRT, 1, 0);
  const a = (await place(env, body(1))).json.id;
  const early = await place(env, body(1), () => NOW + 10 * MIN);
  assert.equal(early.status, 409);
  assert.equal(early.json.error.code, 'bag-changed');
  assert.equal(order(env, a).stockCommitted, true);
  const late = await place(env, body(1), () => NOW + 16 * MIN);
  assert.equal(late.status, 201);
  assert.equal(order(env, a).stockCommitted, false);
  assert.equal(stockOf(env, SHIRT).committed, 1);
});

test('a late payment after release with the unit still there is held again, no alert', async () => {
  const { up, env, id } = await setupHeld();
  const url = await startPay(env, id, NOW + MIN);
  await releaseHold(env, id, { now: at(NOW + 16 * MIN) });
  await back(env, url, NOW + 17 * MIN);
  const o = order(env, id);
  assert.equal(o.paymentStatus, 'PAID');
  assert.equal(o.stockCommitted, true);
  assert.equal(o.holdLost, undefined);
  assert.equal(stockOf(env, SHIRT).committed, 2);
  assert.equal(ownerMails(up).length, 0);
});

test('a late payment after the unit sold again: paid, hold lost, one alert, marker set, fulfil refused', async () => {
  const { up, env, id } = await setupHeld({ onHand: 2 });
  const url = await startPay(env, id, NOW + MIN);
  await releaseHold(env, id, { now: at(NOW + 16 * MIN) });
  assert.equal((await place(env, body(), () => NOW + 16 * MIN)).status, 201); // someone else buys both
  await back(env, url, NOW + 17 * MIN);
  const o = order(env, id);
  assert.deepEqual([o.paymentStatus, o.holdLost, o.stockCommitted, o.alertedLate], ['PAID', true, false, true]);
  assert.equal(ownerMails(up).filter(e => e.subject.includes(id)).length, 1);
  await back(env, url, NOW + 18 * MIN);
  assert.equal(ownerMails(up).filter(e => e.subject.includes(id)).length, 1, 'a replayed return sends no second alert');
  await assert.rejects(act(env, id, { type: 'fulfilled' }, NOW + 20 * MIN), e => e.code === 'stock-short');
  const refunded = await act(env, id, { type: 'refund', lines: [{ key: SHIRT, qty: 2 }], amountCents: 100, restock: false, reason: 'Sold out' }, NOW + 21 * MIN);
  assert.equal(refunded.order.refundedCents, 100);
});

test('a lost alert is retried by the cron once, then never again', async () => {
  let fail = true;
  const up = fakeUpstreams({ resend: { fail: b => fail && b.to[0] === 'owner@evincus.shop' } });
  const env = makeEnv(WIPAY); putStock(env, SHIRT, 2, 0);
  const id = (await place(env, body())).json.id;
  const url = await startPay(env, id, NOW + MIN);
  await releaseHold(env, id, { now: at(NOW + 16 * MIN) });
  await place(env, body(), () => NOW + 16 * MIN);
  await back(env, url, NOW + 17 * MIN);
  assert.deepEqual([order(env, id).holdLost, order(env, id).alertedLate], [true, undefined]);
  fail = false;
  assert.equal(await redriveLate(cron(env, NOW + 30 * MIN)), 1);
  assert.equal(order(env, id).alertedLate, true);
  assert.equal(ownerMails(up).filter(e => e.subject.includes(id)).length, 1);
  assert.equal(await redriveLate(cron(env, NOW + 45 * MIN)), 0);
  assert.equal(ownerMails(up).filter(e => e.subject.includes(id)).length, 1);
});

test('a crash between the paid commit and the follow-up is repaired by redriveLate', async () => {
  const { env, id } = await setupHeld();
  // As the paid commit leaves it when the process dies right after: paid, hold released, nothing re-held.
  await releaseHold(env, id, { now: at(NOW + 16 * MIN) });
  const o = order(env, id);
  await env.ORDERS.put(`order:${id}`, JSON.stringify({ ...o, status: 'PLACED', paymentStatus: 'PAID', holdLost: true, payment: { transactionId: 'x', paidAt: at(NOW + 17 * MIN).toISOString() } }));
  await env.ORDERS.put(`day:2026-10-03:${id}`, '', { metadata: orderSummary({ ...o, paymentStatus: 'PAID', holdLost: true }) });
  assert.equal(await redriveLate(cron(env, NOW + 30 * MIN)), 1);
  assert.equal(order(env, id).stockCommitted, true);
  assert.equal(stockOf(env, SHIRT).committed, 2);
  assert.equal(await recommit(env, id, { now: at(NOW + 31 * MIN) }), 'noop');
});

test('a payment on a cancelled order is accepted, alerted once, and never re-held', async () => {
  const { up, env, id } = await setupHeld();
  const url = await startPay(env, id, NOW + MIN);
  await act(env, id, { type: 'cancel', restock: true }, NOW + 2 * MIN);
  await back(env, url, NOW + 3 * MIN);
  const o = order(env, id);
  assert.deepEqual([o.paymentStatus, o.holdLost, o.stockCommitted], ['PAID', true, false]);
  assert.equal(await recommit(env, id, { now: at(NOW + 4 * MIN) }), 'lost');
  assert.equal(stockOf(env, SHIRT).committed, 0);
  assert.equal(ownerMails(up).filter(e => e.subject.includes(id)).length, 1);
});

test('order metadata carries stockCommitted and holdLost, stays small and has nothing personal', () => {
  const lines = Array.from({ length: 50 }, (_, i) => ({ key: `p${i % 8}-product-id-long|Colour ${i}|XXL`, id: `p${i % 8}`, qty: 10, unitCents: 99999 }));
  const m = orderSummary({ id: 'EV-x', totalCents: 99999999, paymentStatus: 'PARTIALLY_REFUNDED', fulfilmentStatus: 'CANCELLED', fulfillment: { type: 'pickup', location: { id: 'trendy-hats' } }, lines, placedAt: new Date().toISOString(), payment: { paidAt: new Date().toISOString() }, scrubbedAt: 'x', holdLost: true, stockCommitted: false, pii: { v: 1 }, customer: { email: 'a@b.co' } });
  assert.equal(m.stockCommitted, false);
  assert.equal(m.holdLost, true);
  const json = JSON.stringify(m);
  assert.ok(json.length < 1024, String(json.length));
  for (const s of ['a@b.co', 'pii', 'customer', 'email', 'address', 'notes', 'phone']) assert.ok(!json.includes(s), s);
  assert.equal(orderSummary({ lines: [], stockCommitted: true }).holdLost, undefined);
});

test('sweepUnpaid removes week-old unpaid orders that never reached WiPay, and keeps everything else', async () => {
  fakeUpstreams();
  const env = makeEnv(WIPAY); putStock(env, SHIRT, 100, 0);
  const old = NOW - 8 * DAY;
  const placeAt = async ms => (await place(env, body(1), () => ms)).json.id;
  const gone = await placeAt(old);
  const reached = await placeAt(old);
  await call('POST', `/api/orders/${reached}/pay`, { body: {}, env, clock: () => old + MIN });
  const paid = await placeAt(old);
  await back(env, await startPay(env, paid, old + MIN), old + 2 * MIN);
  const recent = await placeAt(NOW - 6 * DAY);
  await releaseExpiredHolds(env, at(NOW));
  assert.equal(await sweepUnpaid(env, at(NOW), { deadline: Date.now() + 30000 }), 1);
  assert.equal(env.ORDERS.store.has(`order:${gone}`), false);
  assert.equal([...env.ORDERS.store.keys()].some(k => k.startsWith('day:') && k.endsWith(gone)), false);
  for (const id of [reached, paid, recent]) assert.ok(env.ORDERS.store.has(`order:${id}`), id);
  assert.equal(UNPAID_TTL, 604800);
});

test('an order changed between the sweep\'s read and its delete is kept', async () => {
  fakeUpstreams();
  const env = makeEnv(WIPAY); putStock(env, SHIRT, 100, 0);
  const id = (await place(env, body(1), () => NOW - 8 * DAY)).json.id;
  await releaseExpiredHolds(env, at(NOW));
  const getEntry = env.ORDERS.getEntry.bind(env.ORDERS);
  env.ORDERS.getEntry = async key => {
    const e = await getEntry(key);
    if (key === `order:${id}`) { env.ORDERS.getEntry = getEntry; await env.ORDERS.put(key, e.value); } // a write lands right after the read
    return e;
  };
  assert.equal(await sweepUnpaid(env, at(NOW), { deadline: Date.now() + 30000 }), 0);
  assert.ok(env.ORDERS.store.has(`order:${id}`));
});