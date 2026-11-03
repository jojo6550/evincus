import test from 'node:test';
import assert from 'node:assert/strict';
import { call, makeEnv, fakeUpstreams, putStock, stockOf } from './helpers/fake-env.mjs';
import { NOW } from './helpers/fixture.mjs';
import { WIPAY, payOrder } from './helpers/pay.mjs';

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
