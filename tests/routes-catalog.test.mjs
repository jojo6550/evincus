import test from 'node:test';
import assert from 'node:assert/strict';
import { call, callWithoutData, seedFromFixture, makeEnv, putStock, captureLogs, fakeUpstreams } from './helpers/fake-env.mjs';
import { FIXTURE, NOW } from './helpers/fixture.mjs';
import { redact } from '../server/lib/log.js';
import { productImages } from '../server/lib/seo.js';
import { serveStatic } from '../server/static.js';

const imagePaths = (eras, products) => [...new Set([...eras.map(e => e.hero), ...products.flatMap(productImages)])].sort();

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
  assert.deepEqual(json.products.map(p => [p.id, p.buyable, p.soldOutVariants]), [['alpha-tee', true, ['White|M']], ['alpha-hood', false, ['Black|M']]]);
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
  fakeUpstreams();
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

test('request ids are random UUIDs, never taken from request headers', async () => {
  const r = await call('GET', '/api/health', { headers: { 'cf-ray': 'ray-123' } });
  assert.match(r.res.headers.get('x-request-id'), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('GET /api/catalog returns every era and every released product in one response', async () => {
  const { status, json, res } = await call('GET', '/api/catalog');
  assert.equal(status, 200);
  assert.equal(json.now, new Date(NOW).toISOString());
  assert.deepEqual(json.eras.map(e => [e.slug, e.status, e.productCount, e.story ?? null]), [['future', 'upcoming', 0, null], ['alpha', 'live', 2, 'Alpha story'], ['old', 'archived', 1, 'Old story']]);
  assert.deepEqual(json.products.map(p => [p.id, p.buyable]), [['alpha-tee', true], ['alpha-hood', false], ['old-tee', false]]);
  assert.deepEqual(json.sales, []);
  assert.equal(res.headers.get('cache-control'), 'public, max-age=60');
});

test('STATUS refuses the API on the public domain with 503, except health and newsletter links', async () => {
  const env = makeEnv({ STATUS: 'stocking' });
  const down = await call('POST', '/api/orders', { env, headers: { host: 'evincus.shop' }, body: {} });
  assert.equal(down.status, 503);
  assert.equal(down.json.error.code, 'stocking');
  assert.equal((await call('GET', '/api/eras', { env: makeEnv({ STATUS: 'maintenance' }), headers: { host: 'evincus.shop' } })).json.error.code, 'maintenance');
  assert.equal((await call('GET', '/api/eras', { env, headers: { host: 'evincus.shop' } })).status, 503);
  assert.notEqual((await call('GET', '/api/health', { env, headers: { host: 'evincus.shop' } })).status, 503);
  assert.notEqual((await call('POST', '/api/newsletter/unsubscribe', { env, headers: { host: 'evincus.shop' }, body: {} })).status, 503);
  assert.equal((await call('GET', '/api/eras', { env, headers: { host: 'evincus-dev.onrender.com' } })).status, 200);
});

test('without injected data the API serves the KV catalog with stock applied and a media map', async () => {
  const env = makeEnv(); await seedFromFixture(env);
  const r = await callWithoutData('GET', '/api/catalog', { env });
  assert.equal(r.status, 200);
  const img = r.json.products.find(p => p.id === 'alpha-tee').colors[0].images[0];
  assert.match(img, /^media\//);
  assert.ok(r.json.media[img].variants.length);
  assert.equal(r.json.products.some(p => 'costCents' in p || 'available' in p || 'skus' in p), false);
  assert.deepEqual(Object.keys(r.json.media).sort(), imagePaths(r.json.eras, r.json.products));
  assert.deepEqual(r.json.products.map(p => [p.id, p.buyable, p.soldOutVariants]).sort(),
    [['alpha-hood', false, ['Black|M']], ['alpha-tee', true, ['White|M']], ['old-tee', false, []]]);

  const era = await callWithoutData('GET', '/api/eras/alpha', { env });
  assert.deepEqual(Object.keys(era.json.media).sort(), imagePaths([era.json], era.json.products));
  const product = await callWithoutData('GET', '/api/products/alpha-tee', { env });
  assert.deepEqual(Object.keys(product.json.media).sort(), imagePaths([], [product.json]));
  assert.ok(Object.keys(product.json.media).length);
});

test('health counts the KV catalog and fails until it is seeded', async () => {
  const env = makeEnv();
  const empty = await callWithoutData('GET', '/api/health', { env });
  assert.equal(empty.status, 503);
  assert.deepEqual(empty.json.catalog, { eras: 0, products: 0 });
  await seedFromFixture(env);
  const seeded = await callWithoutData('GET', '/api/health', { env });
  assert.equal(seeded.status, 200);
  assert.deepEqual(seeded.json.catalog, { eras: 3, products: 4 });
});

test('a draft product is absent from catalog, era, product, quote, product page and sitemap', async () => {
  const data = {
    ...FIXTURE,
    eras: FIXTURE.eras.map(e => (e.slug === 'old' ? { ...e, state: 'archived' } : e)),
    products: [
      ...FIXTURE.products.map(p => (p.id === 'alpha-hood' ? { ...p, status: 'draft' } : p)),
      { ...FIXTURE.products[1], id: 'alpha-cap', name: 'Alpha Cap', status: 'archived' },
    ],
  };
  const env = makeEnv(); await seedFromFixture(env, data);
  putStock(env, 'alpha-hood|Black|M', 10); putStock(env, 'alpha-cap|Black|M', 10);
  const hidden = ['alpha-hood', 'alpha-cap', 'old-tee'];
  const leaks = text => [...hidden, 'Alpha Hood', 'Alpha Cap', 'Old Tee'].filter(s => text.includes(s));

  const catalog = await callWithoutData('GET', '/api/catalog', { env });
  assert.deepEqual(catalog.json.products.map(p => p.id), ['alpha-tee']);
  assert.deepEqual(catalog.json.eras.map(e => e.slug), ['future', 'alpha']);
  assert.deepEqual(leaks(catalog.text), []);
  const eras = await callWithoutData('GET', '/api/eras', { env });
  assert.deepEqual(eras.json.eras.map(e => [e.slug, e.productCount]), [['future', 0], ['alpha', 1]]);
  const era = await callWithoutData('GET', '/api/eras/alpha', { env });
  assert.deepEqual(era.json.products.map(p => p.id), ['alpha-tee']);
  assert.deepEqual(leaks(era.text), []);
  assert.equal((await callWithoutData('GET', '/api/eras/old', { env })).status, 404);
  for (const id of hidden) assert.equal((await callWithoutData('GET', `/api/products/${id}`, { env })).json.error.code, 'unknown-product', id);

  const q = await callWithoutData('POST', '/api/bag/quote', { env, body: { items: hidden.map(id => ({ id, color: 'Black', size: 'M', qty: 1 })) } });
  assert.deepEqual(q.json.lines.map(l => l.status), ['unknown-item', 'unknown-item', 'unknown-item']);
  assert.deepEqual(leaks(q.text).filter(s => !hidden.includes(s)), [], 'lines echo the requested ids, never names');

  const page = { 'index.html': '<head><!-- seo --><title>Home</title><!-- /seo --></head>', '404.html': 'not found' };
  const readFile = async path => { if (!(path in page)) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); return new TextEncoder().encode(page[path]); };
  const at = path => serveStatic(new Request(`https://shop.test${path}`), { env, readFile, now: new Date(NOW) });
  assert.equal((await at('/products/alpha-tee')).status, 200);
  for (const id of hidden) assert.equal((await at(`/products/${id}`)).status, 404, id);
  const sitemap = await (await at('/sitemap.xml')).text();
  assert.match(sitemap, /products\/alpha-tee/);
  assert.deepEqual(leaks(sitemap), []);
});
