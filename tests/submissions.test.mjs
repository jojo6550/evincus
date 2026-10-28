import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeKV, putStock, stockOf } from './helpers/fake-env.mjs';
import { skip, memoryKv } from './helpers/deno-kv.mjs';
import { kvStore } from '../server/lib/kv-store.js';
import { submitOrder } from '../server/lib/submissions.js';

const record = (over = {}) => ({ id: 'EV-1', placedAt: '2026-10-03T12:00:00.000Z', totalCents: 100, lines: [], ...over });
const SHIRT = 'alpha-tee|Black|S';
const shirt = (qty = 1) => record({ lines: [{ key: SHIRT, id: 'alpha-tee', color: 'Black', size: 'S', qty }] });
const env = () => ({ ORDERS: fakeKV() });

test('the first submit writes the submission, order, day index and retry job together', async () => {
  const e = env();
  assert.deepEqual(await submitOrder(e, 'EV-1', 'fp', null), { record: null });
  assert.equal(e.ORDERS.store.size, 0);
  assert.deepEqual(await submitOrder(e, 'EV-1', 'fp', record()), { record: record() });
  assert.deepEqual([...e.ORDERS.store.keys()].sort(), ['day:2026-10-03:EV-1', 'email-retry:EV-1', 'order:EV-1', 'submission:EV-1']);
  assert.deepEqual(JSON.parse(e.ORDERS.store.get('email-retry:EV-1').value), { retries: 0, nextAt: Date.parse('2026-10-03T12:00:00.000Z') });
  assert.equal(e.ORDERS.store.get('order:EV-1').opts.expirationTtl, 63072000);
});

test('a replay returns the saved record and a different fingerprint conflicts', async () => {
  const e = env();
  await submitOrder(e, 'EV-1', 'fp', record());
  assert.deepEqual(await submitOrder(e, 'EV-1', 'fp', record({ totalCents: 999 })), { record: record() });
  assert.deepEqual(await submitOrder(e, 'EV-1', 'fp', null), { record: record() });
  assert.deepEqual(await submitOrder(e, 'EV-1', 'other', null), { conflict: true });
});

test('concurrent submits of one token produce one order', async () => {
  const e = env();
  const results = await Promise.all([1, 2, 3, 4, 5].map(n => submitOrder(e, 'EV-1', 'fp', record({ totalCents: n }))));
  const winner = results[0].record.totalCents;
  assert.ok(results.every(r => r.record.totalCents === winner));
  assert.equal(JSON.parse(e.ORDERS.store.get('order:EV-1').value).totalCents, winner);
});

test('over real Deno KV, concurrent submits of one token produce one order and one retry job', { skip }, async t => {
  const e = { ORDERS: kvStore(await memoryKv(t)) };
  const results = await Promise.all([1, 2, 3, 4, 5].map(n => submitOrder(e, 'EV-1', 'fp', record({ totalCents: n }))));
  const winner = results[0].record.totalCents;
  assert.ok(results.every(r => r.record.totalCents === winner));
  assert.equal(JSON.parse(await e.ORDERS.get('order:EV-1')).totalCents, winner);
  assert.notEqual(await e.ORDERS.get('email-retry:EV-1'), null);
  assert.equal(await e.ORDERS.get('day:2026-10-03:EV-1'), '');
  assert.deepEqual(await submitOrder(e, 'EV-1', 'other', null), { conflict: true });
});

test('a failed write saves nothing and the same submit then succeeds', async () => {
  const e = env();
  e.ORDERS.failPuts = key => key.startsWith('day:');
  await assert.rejects(submitOrder(e, 'EV-1', 'fp', record()), /KV put failed/);
  assert.equal(e.ORDERS.store.size, 0);
  e.ORDERS.failPuts = null;
  assert.deepEqual(await submitOrder(e, 'EV-1', 'fp', record()), { record: record() });
});

test('the commit checks the version that was read, so an expired leftover entry does not block the token', async () => {
  const e = env();
  e.ORDERS.getEntry = async () => ({ value: null, version: 'leftover' });
  const seen = [];
  e.ORDERS.commit = async ({ checks }) => { seen.push(...checks); return true; };
  await submitOrder(e, 'EV-1', 'fp', record());
  assert.deepEqual(seen, [{ key: 'submission:EV-1', version: 'leftover' }]);
});

test('repeated lost races give up instead of looping forever', async () => {
  const e = env();
  e.ORDERS.commit = async () => false;
  await assert.rejects(submitOrder(e, 'EV-1', 'fp', record()), /Order storage unavailable/);
});

test('a round that loses the race re-reads stock: units taken in between are never committed twice', async () => {
  const e = env(); putStock(e, SHIRT, 1, 0);
  const commit = e.ORDERS.commit.bind(e.ORDERS);
  let commits = 0;
  // Another checkout takes the last unit after this one has read the stock document.
  e.ORDERS.commit = async op => { if (!commits++) putStock(e, SHIRT, 1, 1); return commit(op); };
  assert.deepEqual(await submitOrder(e, 'EV-1', 'fp', shirt()), { short: [{ key: SHIRT, available: 0 }] });
  assert.equal(commits, 1);
  assert.deepEqual(stockOf(e, SHIRT), { onHand: 1, committed: 1 });
  assert.equal(e.ORDERS.store.has('order:EV-1'), false);
});

test('a double click on the last unit returns its one order, never a shortage of its own making', async () => {
  const e = env(); putStock(e, SHIRT, 1, 0);
  const getEntry = e.ORDERS.getEntry.bind(e.ORDERS);
  let other = true;
  // The other click's order lands after this click has read the submission.
  e.ORDERS.getEntry = async key => {
    const entry = await getEntry(key);
    if (other && key.startsWith('submission:')) { other = false; await submitOrder(e, 'EV-1', 'fp', shirt()); }
    return entry;
  };
  assert.deepEqual(await submitOrder(e, 'EV-1', 'fp', shirt()), { record: shirt() });
  assert.equal(stockOf(e, SHIRT).committed, 1);
});

test('stock is committed in the order commit, with one adj: record per line', async () => {
  const e = env(); putStock(e, SHIRT, 5, 1); putStock(e, 'alpha-tee|Black|M', 2, 0);
  const rec = record({ lines: [...shirt(2).lines, { key: 'alpha-tee|Black|M', id: 'alpha-tee', color: 'Black', size: 'M', qty: 2 }] });
  assert.deepEqual(await submitOrder(e, 'EV-1', 'fp', rec), { record: rec });
  assert.deepEqual(stockOf(e, SHIRT), { onHand: 5, committed: 3 });
  assert.deepEqual(stockOf(e, 'alpha-tee|Black|M'), { onHand: 2, committed: 2 });
  assert.deepEqual(JSON.parse(e.ORDERS.store.get('adj:alpha-tee:2026-10-03T12:00:00.000Z:EV-1:1').value),
    { key: 'alpha-tee|Black|M', onHand: 0, committed: 2, reason: 'order', note: '', by: null, at: '2026-10-03T12:00:00.000Z', orderId: 'EV-1' });
  assert.equal([...e.ORDERS.store.keys()].filter(k => k.startsWith('adj:')).length, 2);
});

test('a short line saves nothing; continueSelling products skip the check', async () => {
  const e = env(); putStock(e, SHIRT, 1, 0);
  assert.deepEqual(await submitOrder(e, 'EV-1', 'fp', shirt(2)), { short: [{ key: SHIRT, available: 1 }] });
  assert.equal(e.ORDERS.store.has('submission:EV-1'), false);
  assert.deepEqual(await submitOrder(e, 'EV-1', 'fp', shirt(2), { products: [{ id: 'alpha-tee', continueSelling: true }] }), { record: shirt(2) });
  assert.deepEqual(stockOf(e, SHIRT), { onHand: 1, committed: 2 });
});
