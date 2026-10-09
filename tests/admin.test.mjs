import test from 'node:test';
import assert from 'node:assert/strict';
import { call, makeEnv } from './helpers/fake-env.mjs';
import { NOW } from './helpers/fixture.mjs';
import { SALES_KEY } from '../server/lib/sales.js';

const TOKEN = 'admin-test-token';
const iso = ms => new Date(ms).toISOString();
const sale = (over = {}) => ({ id: 's1', percent: 20, eras: ['alpha'], label: null, startsAt: iso(NOW - 3_600_000), endsAt: iso(NOW + 86_400_000), ...over });
const auth = (token = TOKEN) => ({ Authorization: `Bearer ${token}` });
const getSales = (env, headers = auth()) => call('GET', '/api/admin/sales', { env, headers });
const putSales = (env, body, headers = auth()) => call('PUT', '/api/admin/sales', { env, headers, body });

test('the admin routes do not exist without ADMIN_TOKEN, even with a token header', async () => {
  for (const env of [makeEnv(), makeEnv({ ADMIN_TOKEN: '' })]) {
    assert.equal((await getSales(env)).status, 404);
    assert.equal((await putSales(env, { sales: [], version: null })).status, 404);
  }
});

test('a missing, empty, wrong-case or wrong token is 401', async () => {
  const env = makeEnv({ ADMIN_TOKEN: TOKEN });
  for (const headers of [{}, { Authorization: 'Bearer ' }, { Authorization: `bearer ${TOKEN}` }, auth(`${TOKEN}x`), auth('admin-test-tokem'), { Authorization: TOKEN }]) {
    const r = await getSales(env, headers);
    assert.equal(r.status, 401, JSON.stringify(headers));
    assert.equal(r.json.error.code, 'unauthorized');
  }
  assert.equal((await getSales(env)).status, 200);
});

test('GET returns an empty list and a null version when nothing is stored', async () => {
  const r = await getSales(makeEnv({ ADMIN_TOKEN: TOKEN }));
  assert.deepEqual(r.json, { sales: [], version: null });
  assert.equal(r.res.headers.get('cache-control'), 'no-store');
});

test('PUT saves a valid list that GET then returns with its version', async () => {
  const env = makeEnv({ ADMIN_TOKEN: TOKEN });
  const put = await putSales(env, { sales: [sale()], version: null });
  assert.equal(put.status, 200);
  assert.deepEqual(put.json.sales, [sale()]);
  assert.deepEqual(JSON.parse(env.ORDERS.store.get(SALES_KEY).value), [sale()]);
  const got = await getSales(env);
  assert.deepEqual(got.json.sales, [sale()]);
  assert.equal(typeof got.json.version, 'string');
});

test('PUT with a stale version is 409 and changes nothing', async () => {
  const env = makeEnv({ ADMIN_TOKEN: TOKEN });
  await putSales(env, { sales: [sale()], version: null });
  const stale = await putSales(env, { sales: [sale({ id: 's2' })], version: null });
  assert.equal(stale.status, 409);
  assert.equal(stale.json.error.code, 'sales-changed');
  assert.deepEqual(JSON.parse(env.ORDERS.store.get(SALES_KEY).value), [sale()]);
});

test('PUT refuses lists that are not valid sales', async () => {
  const env = makeEnv({ ADMIN_TOKEN: TOKEN });
  for (const body of [{ sales: [sale({ percent: 0 })], version: null }, { sales: 'nope', version: null }, { sales: Array.from({ length: 51 }, (_, i) => sale({ id: `s${i}` })), version: null }, { sales: [], version: 5 }, { version: null }]) {
    const r = await putSales(env, body);
    assert.equal(r.status, 400, JSON.stringify(body).slice(0, 80));
    assert.equal(r.json.error.code, 'invalid-sales');
  }
  assert.equal(env.ORDERS.store.has(SALES_KEY), false);
});

test('a saved sale reprices the store on the next request', async () => {
  const env = makeEnv({ ADMIN_TOKEN: TOKEN });
  await putSales(env, { sales: [sale()], version: null });
  const era = await call('GET', '/api/eras/alpha', { env });
  assert.deepEqual(era.json.products.map(p => [p.id, p.priceCents]), [['alpha-tee', 2799], ['alpha-hood', 3679]]);
});
