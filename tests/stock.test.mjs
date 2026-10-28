import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, putStock, stockOf, captureLogs } from './helpers/fake-env.mjs';
import { signIn, post, ADMIN_TOKEN } from './helpers/staff.mjs';
import { NOW } from './helpers/fixture.mjs';

const K = 'alpha-tee|White|S'; // 10 on hand, 0 committed in the fixture
const env0 = () => makeEnv({ ADMIN_TOKEN });
const adj = env => [...env.ORDERS.store].filter(([k]) => k.startsWith('adj:')).map(([k, v]) => ({ k, ...JSON.parse(v.value) }));
const send = (env, cookie, over = {}) => post(env, cookie, '/api/inventory/stock', { opId: crypto.randomUUID(), productId: 'alpha-tee', changes: [{ key: K, delta: 3 }], reason: 'received', note: 'box 1', ...over });

test('two owners adding stock at once both land', async () => {
  const env = env0();
  const [a, b] = await Promise.all([signIn(env, 'owner', 'a@evincus.shop'), signIn(env, 'owner', 'b@evincus.shop')]);
  const [x, y] = await Promise.all([send(env, a), send(env, b)]);
  assert.deepEqual([x.status, y.status], [200, 200]);
  assert.equal(stockOf(env, K).onHand, 16);
  const rows = adj(env);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(r => r.by).sort(), ['a@evincus.shop', 'b@evincus.shop']);
  const r = rows[0];
  assert.deepEqual([r.key, r.onHand, r.committed, r.reason, r.note, r.at], [K, 3, 0, 'received', 'box 1', new Date(NOW).toISOString()]);
});

test('a retried opId applies once and returns the first result', async () => {
  const env = env0();
  const cookie = await signIn(env);
  const opId = crypto.randomUUID();
  const first = await send(env, cookie, { opId });
  const again = await send(env, cookie, { opId });
  const other = await send(env, cookie, { opId, changes: [{ key: K, delta: 9 }] }); // same id, other payload: first result wins
  assert.equal(first.status, 200);
  assert.deepEqual(first.json, { stock: { [K]: { onHand: 13, committed: 0 } } });
  assert.equal(again.text, first.text);
  assert.equal(other.text, first.text);
  assert.equal(stockOf(env, K).onHand, 13);
  assert.equal(adj(env).length, 1);
  assert.equal(env.ORDERS.store.get('op:' + opId).opts.expirationTtl, 604800);
});

test('lowering below committed is refused; raising an oversold variant is allowed', async () => {
  const env = env0();
  const cookie = await signIn(env);
  putStock(env, K, 1, 2);
  const no = await send(env, cookie, { changes: [{ key: K, delta: -1 }] });
  assert.deepEqual([no.status, no.json.error.code, no.json.error.key], [409, 'stock-below-committed', K]);
  assert.equal(no.json.error.message, "You can't remove units that are promised to orders. Cancel or refund the order first.");
  assert.deepEqual(stockOf(env, K), { onHand: 1, committed: 2 });
  assert.equal(adj(env).length, 0);
  const ok = await send(env, cookie, { changes: [{ key: K, delta: 5 }] });
  assert.equal(ok.status, 200);
  assert.deepEqual(stockOf(env, K), { onHand: 6, committed: 2 });
  putStock(env, K, 1, 0);
  assert.equal((await send(env, cookie, { changes: [{ key: K, delta: -2 }] })).json.error.code, 'stock-below-committed'); // below zero
  assert.equal((await send(env, cookie, { changes: [{ key: K, delta: -1 }] })).status, 200);
  assert.equal(stockOf(env, K).onHand, 0);
});

test('a refused batch writes nothing and a multi-change batch lands together', async () => {
  const env = env0();
  const cookie = await signIn(env);
  const K2 = 'alpha-tee|Black, white print|M';
  const bad = await send(env, cookie, { changes: [{ key: K, delta: 1 }, { key: K2, delta: -11 }] });
  assert.deepEqual([bad.status, bad.json.error.key], [409, K2]);
  assert.equal(stockOf(env, K).onHand, 10);
  const ok = await send(env, cookie, { changes: [{ key: K, delta: 1 }, { key: K2, delta: -4 }, { key: K, delta: 2 }] });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json.stock, { [K]: { onHand: 13, committed: 0 }, [K2]: { onHand: 6, committed: 0 } });
  assert.equal(adj(env).length, 3);
});

test('a lost commit retries from the read, and gives up after 5 rounds', async () => {
  const env = env0();
  const cookie = await signIn(env);
  const real = env.ORDERS.commit.bind(env.ORDERS);
  let lose = 2;
  env.ORDERS.commit = async o => (o.puts.some(p => p.key.startsWith('adj:')) && lose-- > 0 ? false : real(o));
  assert.equal((await send(env, cookie)).status, 200);
  assert.equal(stockOf(env, K).onHand, 13);
  env.ORDERS.commit = async () => false;
  const r = await send(env, cookie);
  assert.deepEqual([r.status, r.json.error.code], [409, 'stock-busy']);
});

test('the commit stays within 2 checks', async () => {
  const env = env0();
  const cookie = await signIn(env);
  const real = env.ORDERS.commit.bind(env.ORDERS);
  let max = 0;
  env.ORDERS.commit = async o => { if (o.puts.some(p => p.key.startsWith('adj:'))) max = Math.max(max, o.checks.length); return real(o); };
  await send(env, cookie);
  assert.ok(max >= 1 && max <= 2);
});

test('bad requests are 400 invalid-stock or 404 unknown-product, and change nothing', async () => {
  const env = env0();
  const cookie = await signIn(env);
  const bad = [
    { opId: 'nope' }, { opId: undefined }, { reason: 'because' }, { reason: undefined }, { note: 'x'.repeat(201) }, { note: 5 },
    { changes: [] }, { changes: 'x' }, { changes: Array.from({ length: 201 }, () => ({ key: K, delta: 1 })) },
    { changes: [{ key: K, delta: 0 }] }, { changes: [{ key: K, delta: 1.5 }] }, { changes: [{ key: K, delta: '1' }] },
    { changes: [{ key: 'alpha-hood|Black|M', delta: 1 }] }, // another product
    { changes: [{ key: 'alpha-tee|Red|S', delta: 1 }] }, { changes: [{ key: 'alpha-tee|White|XL', delta: 1 }] }, { changes: [{ key: 5, delta: 1 }] },
  ];
  for (const over of bad) {
    const r = await send(env, cookie, over);
    assert.deepEqual([r.status, r.json.error.code], [400, 'invalid-stock'], JSON.stringify(over).slice(0, 80));
  }
  assert.equal((await send(env, cookie, { changes: Array.from({ length: 200 }, () => ({ key: K, delta: 1 })) })).status, 200);
  assert.equal((await send(env, cookie, { note: 'x'.repeat(200), changes: [{ key: K, delta: 1 }] })).status, 200);
  assert.equal((await send(env, cookie, { note: undefined, changes: [{ key: K, delta: 1 }] })).status, 200);
  const un = await send(env, cookie, { productId: 'ghost' });
  assert.deepEqual([un.status, un.json.error.code], [404, 'unknown-product']);
  assert.equal(stockOf(env, K).onHand, 10 + 200 + 1 + 1);
});

test('viewers get 403, signed-out 401, and cross-origin writes get bad-origin', async () => {
  const env = env0();
  const viewer = await signIn(env, 'viewer');
  const owner = await signIn(env);
  assert.deepEqual([(await send(env, viewer)).status, (await send(env, viewer)).json.error.code], [403, 'forbidden']);
  assert.equal((await send(env, '')).status, 401);
  const x = await send(env, owner, undefined);
  assert.equal(x.status, 200);
  const cross = await post(env, owner, '/api/inventory/stock', { opId: crypto.randomUUID(), productId: 'alpha-tee', changes: [{ key: K, delta: 1 }], reason: 'other' }, { origin: 'https://evil.test' });
  assert.deepEqual([cross.status, cross.json.error.code], [403, 'bad-origin']);
  assert.equal(stockOf(env, K).onHand, 13);
});

test('logs stock.adjusted with the account and change count', async () => {
  const env = env0();
  const cookie = await signIn(env);
  const logs = captureLogs();
  try { await send(env, cookie, { changes: [{ key: K, delta: 1 }, { key: K, delta: 1 }] }); } finally { logs.restore(); }
  const l = logs.lines.find(x => x.event === 'stock.adjusted');
  assert.equal(l.changes, 2);
  assert.ok(l.account);
});
