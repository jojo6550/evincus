import test from 'node:test';
import assert from 'node:assert/strict';
import { call, makeEnv, captureLogs } from './helpers/fake-env.mjs';
import { FIXTURE, NOW } from './helpers/fixture.mjs';
import { redact } from '../worker/src/lib/log.js';

test('GET /api/eras lists eras with status; upcoming has no story and no products', async () => {
  const { status, json, res } = await call('GET', '/api/eras');
  assert.equal(status, 200);
  assert.equal(json.now, new Date(NOW).toISOString());
  assert.deepEqual(json.eras.map(e => [e.slug, e.status, e.productCount]), [['future', 'upcoming', 0], ['alpha', 'live', 2], ['old', 'archived', 1]]);
  assert.ok(json.eras.every(e => !('story' in e)));
  assert.equal(res.headers.get('cache-control'), 'public, max-age=60');
  assert.ok(res.headers.get('x-request-id'));
});

test('catalog cache never outlives the next drop', async () => {
  const drop = Date.parse(FIXTURE.eras[0].dropsAt);
  const { res } = await call('GET', '/api/eras', { clock: () => drop - 20_000 });
  assert.equal(res.headers.get('cache-control'), 'public, max-age=20');
});

test('upcoming era returns a teaser with no products or story', async () => {
  const { status, json } = await call('GET', '/api/eras/future');
  assert.equal(status, 200);
  assert.equal(json.name, 'Future');
  assert.equal(json.status, 'upcoming');
  assert.deepEqual(json.products, []);
  assert.ok(!('story' in json));
});

test('live era returns story and products with buyable flags', async () => {
  const { json } = await call('GET', '/api/eras/alpha');
  assert.equal(json.story, 'Alpha story');
  assert.deepEqual(json.products.map(p => [p.id, p.buyable, p.soldOutVariants]), [['alpha-tee', true, ['White|M']], ['alpha-hood', false, []]]);
});

test('unknown era is 404 with a shopper message and the request id', async () => {
  const { status, json, res } = await call('GET', '/api/eras/nope');
  assert.equal(status, 404);
  assert.equal(json.error.code, 'unknown-era');
  assert.equal(typeof json.error.message, 'string');
  assert.equal(json.error.requestId, res.headers.get('x-request-id'));
});

test('a product in an upcoming era is indistinguishable from an unknown one', async () => {
  const hidden = await call('GET', '/api/products/future-tee');
  const missing = await call('GET', '/api/products/nope');
  assert.equal(hidden.status, 404);
  assert.equal(missing.status, 404);
  assert.equal(hidden.json.error.code, missing.json.error.code);
  assert.equal(hidden.json.error.message, missing.json.error.message);
  assert.ok(!hidden.text.includes('Future Tee'));
});

test('product returns era summary and buyable', async () => {
  const { status, json } = await call('GET', '/api/products/old-tee');
  assert.equal(status, 200);
  assert.deepEqual(json.era, { slug: 'old', name: 'Old', status: 'archived' });
  assert.equal(json.buyable, false);
});

test('a drop goes live at dropsAt', async () => {
  const drop = Date.parse(FIXTURE.eras[0].dropsAt);
  assert.equal((await call('GET', '/api/products/future-tee', { clock: () => drop - 1 })).status, 404);
  assert.equal((await call('GET', '/api/products/future-tee', { clock: () => drop })).status, 200);
});

test('unknown path is 404, wrong method is 405', async () => {
  assert.equal((await call('GET', '/api/nope')).json.error.code, 'not-found');
  const r = await call('POST', '/api/eras', { body: {} });
  assert.equal(r.status, 405);
  assert.equal(r.json.error.code, 'method-not-allowed');
});

test('health reports catalog, KV and commit', async () => {
  const { status, json, res } = await call('GET', '/api/health');
  assert.equal(status, 200);
  assert.deepEqual(json, { ok: true, catalog: { eras: 3, products: 4 }, kv: 'ok', commit: 'abc1234' });
  assert.equal(res.headers.get('cache-control'), 'no-store');
});

test('health is 503 when KV fails', async () => {
  const env = makeEnv();
  env.ORDERS.failGets = () => true;
  const { status, json } = await call('GET', '/api/health', { env });
  assert.equal(status, 503);
  assert.equal(json.ok, false);
  assert.equal(json.kv, 'error');
});

test('CORS: allowed origin echoed, others get nothing, preflight is 204', async () => {
  const ok = await call('GET', '/api/eras', { headers: { Origin: 'https://evincus.shop' } });
  assert.equal(ok.res.headers.get('access-control-allow-origin'), 'https://evincus.shop');
  assert.equal(ok.res.headers.get('vary'), 'Origin');
  const bad = await call('GET', '/api/eras', { headers: { Origin: 'https://evil.test' } });
  assert.equal(bad.res.headers.get('access-control-allow-origin'), null);
  const pre = await call('OPTIONS', '/api/bag/quote', { headers: { Origin: 'https://evincus.shop' } });
  assert.equal(pre.status, 204);
  assert.match(pre.res.headers.get('access-control-allow-methods'), /POST/);
  assert.match(pre.res.headers.get('access-control-allow-headers'), /Content-Type/);
});

test('localhost is allowed only outside production', async () => {
  const headers = { Origin: 'http://localhost:5180' };
  const prod = await call('GET', '/api/eras', { headers });
  assert.equal(prod.res.headers.get('access-control-allow-origin'), null);
  const dev = await call('GET', '/api/eras', { headers, env: makeEnv({ ENVIRONMENT: 'development' }) });
  assert.equal(dev.res.headers.get('access-control-allow-origin'), 'http://localhost:5180');
});

test('unhandled errors return 500 and log "unhandled"', async () => {
  const logs = captureLogs();
  try {
    const { status, json } = await call('GET', '/api/eras', { data: null });
    assert.equal(status, 500);
    assert.equal(json.error.code, 'server-error');
  } finally { logs.restore(); }
  assert.ok(logs.lines.some(l => l.event === 'unhandled' && l.level === 'error'));
});

test('every request logs one request line with route, status and ms', async () => {
  const logs = captureLogs();
  try { await call('GET', '/api/eras/nope'); } finally { logs.restore(); }
  const req = logs.lines.filter(l => l.event === 'request');
  assert.equal(req.length, 1);
  assert.equal(req[0].route, 'GET /api/eras/nope');
  assert.equal(req[0].status, 404);
  assert.equal(req[0].level, 'warn');
  assert.equal(typeof req[0].ms, 'number');
  assert.ok(req[0].reqId);
});

test('redact drops PII keys at any depth', () => {
  const out = redact({ orderId: 'X', payer: { email: 'a@b.c' }, lines: [{ name: 'Tee', sku: 's' }], nested: { shipTo: {}, phone: '1', ok: 1 } });
  assert.deepEqual(out, { orderId: 'X', lines: [{ sku: 's' }], nested: { ok: 1 } });
});
