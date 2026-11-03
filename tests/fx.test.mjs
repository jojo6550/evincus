import test from 'node:test';
import assert from 'node:assert/strict';
import { call, makeEnv, makeCtx, fakeUpstreams } from './helpers/fake-env.mjs';
import { NOW } from './helpers/fixture.mjs';
import { getRates, refreshRates, FX_KEY, FX_MAX_AGE_MS } from '../server/lib/fx.js';

const body = (rates = { USD: 1, JMD: 157.2, EUR: 0.92 }) => ({ result: 'success', time_last_update_unix: 1729728000, rates });
const quiet = { info() {}, warn() {}, error() {} };
const ctx = (env, now = NOW) => { const x = makeCtx(); return { c: { env, now: new Date(now), log: quiet, waitUntil: x.waitUntil }, settle: x.settle }; };
const fxCalls = up => up.calls.filter(c => c.host === 'open.er-api.com').length;
const cached = (env, fetchedAt, rates = { USD: 1, JMD: 150 }) => env.ORDERS.put(FX_KEY, JSON.stringify({ fetchedAt, updatedAt: '2026-10-01T00:00:00.000Z', rates }));

test('an empty cache fetches once and stores the rates', async () => {
  const up = fakeUpstreams({ fx: { reply: () => ({ body: body() }) } });
  const env = makeEnv();
  const { c } = ctx(env);
  assert.deepEqual(await getRates(c), { base: 'USD', updatedAt: new Date(1729728000 * 1000).toISOString(), rates: { USD: 1, JMD: 157.2, EUR: 0.92 } });
  assert.equal(fxCalls(up), 1);
  assert.deepEqual(await env.ORDERS.get(FX_KEY, 'json'), { fetchedAt: new Date(NOW).toISOString(), updatedAt: new Date(1729728000 * 1000).toISOString(), rates: { USD: 1, JMD: 157.2, EUR: 0.92 } });
});

test('a fresh cache does not fetch; a stale one answers at once and refreshes after', async () => {
  const up = fakeUpstreams({ fx: { reply: () => ({ body: body() }) } });
  const env = makeEnv();
  await cached(env, new Date(NOW - FX_MAX_AGE_MS + 60000).toISOString());
  const fresh = ctx(env);
  assert.equal((await getRates(fresh.c)).rates.JMD, 150);
  await fresh.settle();
  assert.equal(fxCalls(up), 0);
  await cached(env, new Date(NOW - FX_MAX_AGE_MS - 1).toISOString());
  const stale = ctx(env);
  assert.equal((await getRates(stale.c)).rates.JMD, 150, 'old rates now, new ones next time');
  await stale.settle();
  assert.equal(fxCalls(up), 1);
  assert.equal((await env.ORDERS.get(FX_KEY, 'json')).rates.JMD, 157.2);
});

test('a source that is down or unsuccessful keeps the last good rates', async () => {
  for (const reply of [() => { throw new Error('down'); }, () => ({ body: { result: 'error' } }), () => ({ status: 500, body: {} })]) {
    fakeUpstreams({ fx: { reply } });
    const env = makeEnv();
    await cached(env, new Date(NOW - FX_MAX_AGE_MS - 1).toISOString());
    const { c } = ctx(env);
    assert.equal(await refreshRates(c), false);
    assert.equal((await env.ORDERS.get(FX_KEY, 'json')).rates.JMD, 150);
  }
});

test('never fetched and the source down: USD only', async () => {
  fakeUpstreams({ fx: { reply: () => { throw new Error('down'); } } });
  const { c } = ctx(makeEnv());
  assert.deepEqual(await getRates(c), { base: 'USD', updatedAt: null, rates: { USD: 1 } });
});

test('bad rates are dropped; a body without USD 1 is rejected whole', async () => {
  fakeUpstreams({ fx: { reply: () => ({ body: body({ USD: 1, JMD: 157.2, BAD: NaN, ZER: 0, NEG: -2, usd: 1, JMDX: 3, STR: '1.2' }) }) } });
  const env = makeEnv();
  assert.equal(await refreshRates(ctx(env).c), true);
  assert.deepEqual((await env.ORDERS.get(FX_KEY, 'json')).rates, { USD: 1, JMD: 157.2 });
  fakeUpstreams({ fx: { reply: () => ({ body: body({ USD: 2, JMD: 157.2 }) }) } });
  const env2 = makeEnv();
  assert.equal(await refreshRates(ctx(env2).c), false);
  assert.equal(await env2.ORDERS.get(FX_KEY), null);
});

test('GET /api/currencies serves the rates with an hour of public caching', async () => {
  fakeUpstreams({ fx: { reply: () => ({ body: body() }) } });
  const r = await call('GET', '/api/currencies', { env: makeEnv() });
  assert.equal(r.status, 200);
  assert.equal(r.res.headers.get('cache-control'), 'public, max-age=3600');
  assert.equal(r.json.rates.JMD, 157.2);
});
