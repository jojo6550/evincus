import test from 'node:test';
import assert from 'node:assert/strict';
import { call, makeEnv, fakeUpstreams } from './helpers/fake-env.mjs';
import { signIn, ADMIN_TOKEN } from './helpers/staff.mjs';
import { NOW } from './helpers/fixture.mjs';
import { WIPAY, payOrder } from './helpers/pay.mjs';
import { scrubOrders, PERSONAL_FIELDS } from '../server/lib/retention.js';

const SHIRT = 'alpha-tee|Black, white print|S';
const body = () => ({ checkoutToken: crypto.randomUUID(), items: [{ id: 'alpha-tee', color: 'Black, white print', size: 'S', qty: 2 }], customer: { firstName: 'Ann', lastName: 'Lee', email: 'ann@example.com' }, fulfillment: { type: 'pickup', locationId: 'trendy-hats' }, expectedTotalCents: 8437 });
const keys = (env, prefix) => [...env.ORDERS.store.keys()].filter(k => k.startsWith(prefix));
const order = (env, id) => JSON.parse(env.ORDERS.store.get(`order:${id}`).value);

async function paidOrder() {
  fakeUpstreams();
  const env = makeEnv({ ...WIPAY, ADMIN_TOKEN });
  const cookie = await signIn(env);
  const id = (await call('POST', '/api/orders', { body: body(), env })).json.id;
  await payOrder(env, id);
  return { env, cookie, id };
}
const refund = async (env, cookie, id, { qty = 1, amountCents = 3000, opId = crypto.randomUUID(), clock = () => NOW + 3600000 } = {}) => {
  const { version } = await env.ORDERS.getEntry(`order:${id}`);
  return call('POST', `/api/inventory/orders/${id}/actions`, { env, clock, headers: { cookie, origin: 'https://api.test' }, body: { opId, version, action: { type: 'refund', lines: [{ key: SHIRT, qty }], amountCents, restock: true, reason: 'Wrong size' } } });
};

test('a paid order carries taxCents and feeCents under those names', async () => {
  const { env, id } = await paidOrder();
  const o = order(env, id);
  assert.deepEqual([o.taxCents, o.feeCents], [1050, 389]);
  assert.equal('gct' in o || 'fee' in o, false);
});

test('a refund writes one refund: entry on its Jamaica day, matching the event; a replayed opId writes none', async () => {
  const { env, cookie, id } = await paidOrder();
  const opId = crypto.randomUUID();
  const r = await refund(env, cookie, id, { opId, clock: () => NOW + 86400000 });
  assert.equal(r.status, 200, r.text);
  const ev = order(env, id).events.find(e => e.type === 'refund');
  assert.deepEqual(keys(env, 'refund:'), [`refund:2026-10-04:${id}:${ev.at}:${opId}`]);
  assert.deepEqual(env.ORDERS.store.get(keys(env, 'refund:')[0]).opts.metadata, { amountCents: ev.amountCents, taxCents: ev.taxCents, restock: true, lines: [{ key: SHIRT, qty: 1 }] });
  assert.equal(env.ORDERS.store.get(keys(env, 'refund:')[0]).opts.expirationTtl, undefined);
  const again = await call('POST', `/api/inventory/orders/${id}/actions`, { env, clock: () => NOW + 86400000, headers: { cookie, origin: 'https://api.test' }, body: { opId, version: 'stale', action: { type: 'refund', lines: [{ key: SHIRT, qty: 1 }], amountCents: 3000, restock: true, reason: 'Wrong size' } } });
  assert.equal(again.status, 200);
  assert.equal(keys(env, 'refund:').length, 1);
});

test('two refunds write two entries', async () => {
  const { env, cookie, id } = await paidOrder();
  assert.equal((await refund(env, cookie, id)).status, 200);
  assert.equal((await refund(env, cookie, id, { clock: () => NOW + 7200000 })).status, 200);
  assert.equal(keys(env, 'refund:').length, 2);
});

test('scrubbing after 2 years removes the person and keeps the paid: and refund: entries and totals', async () => {
  const { env, cookie, id } = await paidOrder();
  await refund(env, cookie, id);
  const before = { paid: keys(env, 'paid:'), refund: keys(env, 'refund:') };
  assert.equal(await scrubOrders(env, new Date(NOW + 731 * 86400000)), 1);
  const o = order(env, id);
  for (const f of PERSONAL_FIELDS) assert.equal(f in o, false, f);
  assert.equal(o.totalCents, 8437);
  assert.deepEqual({ paid: keys(env, 'paid:'), refund: keys(env, 'refund:') }, before);
});
