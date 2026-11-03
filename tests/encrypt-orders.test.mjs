import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv } from './helpers/fake-env.mjs';
import { encryptOrders } from '../scripts/encrypt-orders.mjs';
import { revealOrder, orderPuts, ORDER_TTL } from '../server/lib/orders.js';
import { PERSONAL_FIELDS } from '../server/lib/retention.js';

const legacy = id => ({
  id, status: 'PLACED', paymentStatus: 'NOT_COLLECTED', placedAt: '2026-10-03T12:00:00.000Z', fulfilmentStatus: 'UNFULFILLED',
  fulfillment: { type: 'pickup', location: { id: 'trendy-hats', name: 'TrendyHatz' } }, lines: [], subtotalCents: 100, totalCents: 100,
  customer: { name: 'Tanya Marie Brown', email: 'tanya@example.com', phone: '876 555 0142' },
  payer: { name: 'Tanya Marie Brown', email: 'tanya@example.com', phone: '876 555 0142', firstName: 'Tanya' }, notes: 'after 5pm',
});
async function seed(env, ...records) {
  await env.ORDERS.commit({ puts: records.flatMap(orderPuts) });
  for (const r of records) await env.ORDERS.put(`submission:${r.id}`, JSON.stringify({ fingerprint: 'fp', record: r }), { expirationTtl: ORDER_TTL });
}

test('legacy orders and their submissions are sealed in place; a second run seals nothing', async () => {
  const env = makeEnv();
  await seed(env, legacy('EV-1'), legacy('EV-2'));
  assert.deepEqual(await encryptOrders(env), { scanned: 2, sealed: 4 });
  for (const id of ['EV-1', 'EV-2']) {
    const raw = env.ORDERS.store.get(`order:${id}`);
    const sub = env.ORDERS.store.get(`submission:${id}`);
    for (const s of ['tanya@example.com', 'Tanya', 'after 5pm', '555 0142']) {
      assert.ok(!raw.value.includes(s), s);
      assert.ok(!sub.value.includes(s), s);
    }
    const order = JSON.parse(raw.value);
    assert.ok(order.pii);
    for (const f of PERSONAL_FIELDS.filter(f => f !== 'pii')) assert.equal(f in order, false, f);
    assert.equal(raw.opts.expirationTtl, undefined);
    assert.equal(sub.opts.expirationTtl, ORDER_TTL);
    assert.equal(JSON.parse(sub.value).fingerprint, 'fp');
    const shown = await revealOrder(env, order);
    assert.equal(shown.customer.name, 'Tanya Marie Brown');
    assert.equal(shown.customer.email, 'tanya@example.com');
    assert.equal(shown.notes, 'after 5pm');
  }
  assert.equal(env.ORDERS.store.get('day:2026-10-03:EV-1').opts.metadata.payment, 'NOT_COLLECTED');
  assert.deepEqual(await encryptOrders(env), { scanned: 2, sealed: 0 });
});

test('an order changed between read and write is retried onto the new version, not overwritten', async () => {
  const env = makeEnv();
  await seed(env, legacy('EV-1'));
  const getEntry = env.ORDERS.getEntry.bind(env.ORDERS);
  let raced = false;
  env.ORDERS.getEntry = async key => {
    const e = await getEntry(key);
    if (key === 'order:EV-1' && !raced) { // the owner marks it ready after this read
      raced = true;
      await env.ORDERS.put(key, JSON.stringify({ ...JSON.parse(e.value), fulfilmentStatus: 'READY' }));
    }
    return e;
  };
  await encryptOrders(env);
  const order = JSON.parse(env.ORDERS.store.get('order:EV-1').value);
  assert.equal(order.fulfilmentStatus, 'READY');
  assert.ok(order.pii && !order.customer);
});
