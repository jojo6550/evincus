import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { makeEnv, seedFromFixture, makeCtx, captureLogs } from './helpers/fake-env.mjs';
import { createApp } from '../server/index.js';
import { REV_KEY, ERA_ORDER_KEY, IMPORT_BATCH, loadCatalog } from '../server/lib/catalog-store.js';
import { clientIp } from '../server/lib/client-ip.js';
import { main } from '../scripts/inventory-pull.mjs';
import { LOCAL_URL } from '../scripts/lib/admin-cli.mjs';

const PROD = 'https://evincus.shop';
const PROD_TOKEN = 'prod-token';
const LOCAL_TOKEN = 'local-token';
const app = createApp({});
const auth = t => ({ Authorization: `Bearer ${t}` });
const img = (w, h) => sharp({ create: { width: w, height: h, channels: 3, background: '#222' } }).webp().toBuffer();

async function send(env, method, path, { ip, headers = {}, body, raw } = {}) {
  const ctx = makeCtx(ip);
  const init = { method, headers: { ...headers } };
  if (raw !== undefined) init.body = raw;
  else if (body !== undefined) { init.body = JSON.stringify(body); init.headers['Content-Type'] = 'application/json'; }
  const res = await app.fetch(new Request('https://api.test' + path, init), env, ctx);
  await ctx.settle();
  return res;
}

// A production store holding the catalog plus every kind of private data.
async function prodEnv() {
  const env = makeEnv({ ADMIN_TOKEN: PROD_TOKEN });
  await seedFromFixture(env);
  for (const key of ['order:1', 'day:2026-01-01', 'account:a@b.co', 'session:abc', 'log:2026-01-01:x', 'op:123', 'submission:9', 'adj:p:1']) await env.ORDERS.put(key, JSON.stringify({ secret: key }));
  return env;
}
const localEnv = (over = {}) => makeEnv({ ENVIRONMENT: 'development', ADMIN_TOKEN: LOCAL_TOKEN, ...over });
const exportOf = async env => (await send(env, 'GET', '/api/admin/export', { headers: auth(PROD_TOKEN) })).json();
const importTo = (env, body, ip = '127.0.0.1', token = LOCAL_TOKEN) => send(env, 'PUT', '/api/admin/import', { ip, headers: auth(token), body });
const catalogKeys = env => [...env.ORDERS.store.keys()].filter(k => /^(era|product|stock):/.test(k)).sort();
const snapshot = env => JSON.stringify([...env.ORDERS.store].filter(([k]) => k !== REV_KEY && !k.startsWith('log:')).sort(([a], [b]) => (a < b ? -1 : 1)));

test('export has catalog, stock and media names and no orders, accounts or logs', async () => {
  const env = await prodEnv();
  env.MEDIA.files.set('000000000000000000000001-480.webp', new Uint8Array(1));
  const res = await send(env, 'GET', '/api/admin/export', { headers: auth(PROD_TOKEN) });
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.deepEqual(Object.keys(out).sort(), ['eraOrder', 'eras', 'media', 'products', 'rev', 'stock']);
  assert.ok(out.eras.length && out.products.length && out.stock.length && out.media.length);
  const keys = [...out.eras, ...out.products, ...out.stock].map(e => e.key);
  assert.ok(keys.every(k => /^(era|product|stock):/.test(k)));
  assert.doesNotMatch(JSON.stringify(out), /secret|a@b\.co|session|submission/);
  assert.ok(out.media.every(n => /^[0-9a-f]{24}-\d+\.webp$/.test(n)));
  assert.equal((await send(env, 'GET', '/api/admin/export', { headers: auth('nope') })).status, 401);
});

test('import is 404 in production, staging, from a non-loopback address and with a spoofed header', async () => {
  const exported = await exportOf(await prodEnv());
  const media = { ip: '127.0.0.1', headers: auth(LOCAL_TOKEN), raw: await img(480, 600) };
  const cases = [
    ['production', localEnv({ ENVIRONMENT: 'production' }), '127.0.0.1'],
    ['staging', localEnv({ ENVIRONMENT: 'staging' }), '127.0.0.1'],
    ['remote', localEnv(), '8.8.8.8'],
    ['unknown', localEnv(), undefined],
    ['spoofed', localEnv(), '8.8.8.8'],
  ];
  for (const [name, env, ip] of cases) {
    const headers = { ...auth(LOCAL_TOKEN), ...(name === 'spoofed' && { 'x-forwarded-for': '127.0.0.1', 'x-real-ip': '127.0.0.1' }) };
    const res = await send(env, 'PUT', '/api/admin/import', { ip, headers, body: exported });
    assert.equal(res.status, 404, name);
    assert.deepEqual(catalogKeys(env), catalogKeys(localEnv()), name); // nothing written
    const m = await send(env, 'PUT', '/api/admin/media/000000000000000000000001-480.webp', { ...media, ip, headers });
    assert.equal(m.status, 404, name);
    assert.equal(env.MEDIA.files.size, 0, name);
  }
  // A wrong token on a local dev server is the ordinary 401, so the 404 above comes from the guard alone.
  assert.equal((await importTo(localEnv(), exported, '127.0.0.1', 'bad')).status, 401);
});

test('a forwarding header cannot make a remote caller look local', () => {
  const req = { headers: { 'x-forwarded-for': '127.0.0.1' }, socket: { remoteAddress: '8.8.8.8' } };
  assert.equal(clientIp(req, {}), '8.8.8.8');
  assert.equal(clientIp({ headers: {}, socket: { remoteAddress: '::ffff:127.0.0.1' } }, {}), '127.0.0.1');
});

test('import replaces the local catalog and stock, and a second import changes nothing', async () => {
  const exported = await exportOf(await prodEnv());
  const env = localEnv();
  // Local leftovers: a stale product and era the export lacks, plus private data that must survive.
  await env.ORDERS.put('product:stale', '{"id":"stale"}');
  await env.ORDERS.put('stock:stale', '{}');
  await env.ORDERS.put('era:stale', '{"slug":"stale"}');
  for (const key of ['order:1', 'day:x', 'account:a@b.co', 'session:s', 'log:l', 'op:o', 'submission:s', 'adj:p:1', 'misc']) await env.ORDERS.put(key, 'keep');
  const logs = captureLogs();
  const first = await importTo(env, exported);
  logs.restore();
  assert.equal(first.status, 200);
  assert.ok(JSON.stringify(logs.lines).includes('inventory.pulled'));
  assert.deepEqual(catalogKeys(env), [...exported.eras, ...exported.products, ...exported.stock].map(e => e.key).sort());
  for (const key of ['order:1', 'day:x', 'account:a@b.co', 'session:s', 'log:l', 'op:o', 'submission:s', 'adj:p:1', 'misc']) assert.equal(env.ORDERS.store.get(key).value, 'keep', key);
  assert.deepEqual(JSON.parse(env.ORDERS.store.get(ERA_ORDER_KEY).value), exported.eraOrder);
  assert.equal((await loadCatalog(env)).eras.length, exported.eras.length);
  const before = snapshot(env);
  const second = await importTo(env, exported);
  assert.equal(second.status, 200);
  assert.equal(snapshot(env), before);
});

test('import writes catalog:rev last, in its own commit, and commits stay within 400 mutations', async () => {
  const exported = await exportOf(await prodEnv());
  const extra = Array.from({ length: 900 }, (_, i) => ({ key: `stock:bulk${i}`, value: '{}' }));
  const env = localEnv();
  const commits = [];
  const real = env.ORDERS.commit.bind(env.ORDERS);
  env.ORDERS.commit = async arg => { commits.push(arg); return real(arg); };
  const res = await importTo(env, { ...exported, stock: [...exported.stock, ...extra] });
  assert.equal(res.status, 200);
  assert.ok(commits.length >= 3);
  for (const c of commits) assert.ok(c.puts.length + (c.deletes?.length ?? 0) <= IMPORT_BATCH);
  const last = commits.at(-1);
  assert.deepEqual(last.puts.map(p => p.key).sort(), [ERA_ORDER_KEY, REV_KEY]);
  assert.ok(commits.slice(0, -1).every(c => !c.puts.some(p => p.key === REV_KEY)));
});

test('import rejects malformed bodies and keys outside the catalog', async () => {
  const env = localEnv();
  const good = await exportOf(await prodEnv());
  for (const body of [{}, { ...good, eras: [{ key: 'order:1', value: '{}' }] }, { ...good, stock: [{ key: 'stock:x', value: 'nope' }] }, { ...good, eraOrder: 'x' }]) {
    assert.equal((await importTo(env, body)).status, 400);
  }
  assert.equal(env.ORDERS.store.has(REV_KEY), false);
});

test('media PUT checks name, size and type, and stores a good file', async () => {
  const env = localEnv();
  const webp = await img(480, 600);
  const put = (name, raw) => send(env, 'PUT', `/api/admin/media/${name}`, { ip: '::1', headers: auth(LOCAL_TOKEN), raw });
  assert.equal((await put('000000000000000000000001-480.webp', webp)).status, 204);
  assert.equal(env.MEDIA.files.size, 1);
  assert.equal((await put('bad.webp', webp)).status, 400);
  assert.equal((await put('000000000000000000000002-480.jpg', webp)).status, 400); // webp bytes under a .jpg name
  assert.equal((await put('000000000000000000000003-480.webp', new Uint8Array(10))).status, 400);
  assert.equal((await put('000000000000000000000004-480.webp', new Uint8Array(251 * 1024))).status, 413);
  assert.equal(env.MEDIA.files.size, 1);
});

// Routes URLs to two in-process servers: production (prod) and the local dev server.
function world(prod, local) {
  const calls = [];
  const fetchFn = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method ?? 'GET';
    const headers = init.headers ?? {};
    calls.push({ url, method, headers });
    const isLocal = url.startsWith(LOCAL_URL);
    const env = isLocal ? local : prod;
    if (u.pathname.startsWith('/media/')) {
      const bytes = await env.MEDIA.read(u.pathname.slice(7));
      return bytes ? new Response(method === 'HEAD' ? null : bytes) : new Response(null, { status: 404 });
    }
    return send(env, method, u.pathname, { ip: isLocal ? '127.0.0.1' : '203.0.113.5', headers, raw: init.body });
  };
  return { fetchFn, calls };
}

test('pull uses the production token for export and the local token for import and media', async () => {
  const prod = await prodEnv();
  const local = localEnv();
  const webp = await img(480, 600);
  const names = (await exportOf(prod)).media;
  for (const n of names) prod.MEDIA.files.set(n, new Uint8Array(webp));
  local.MEDIA.files.set(names[0], new Uint8Array(webp)); // already local: not downloaded again
  const { fetchFn, calls } = world(prod, local);
  const out = [];
  const env = { PROD_ADMIN_TOKEN: PROD_TOKEN, ADMIN_TOKEN: LOCAL_TOKEN };
  await main([], { fetchFn, env, log: l => out.push(l), readEnvFile: () => '' });
  const auth_ = (pred) => calls.filter(pred).map(c => c.headers.Authorization);
  assert.deepEqual(auth_(c => c.url === `${PROD}/api/admin/export`), [`Bearer ${PROD_TOKEN}`]);
  assert.deepEqual([...new Set(auth_(c => c.url.startsWith(LOCAL_URL) && c.url.includes('/api/admin/')))], [`Bearer ${LOCAL_TOKEN}`]);
  assert.equal(calls.filter(c => c.method === 'PUT' && c.url.includes('/api/admin/media/')).length, names.length - 1);
  assert.equal(calls.filter(c => c.url === `${PROD}/media/${names[0]}`).length, 0);
  assert.equal(local.MEDIA.files.size, names.length);
  assert.match(out.join('\n'), /eras/);
  assert.equal(catalogKeys(local).length, catalogKeys(prod).length);
  // Rerun: nothing to upload, same catalog.
  const before = snapshot(local);
  calls.length = 0;
  await main([], { fetchFn, env, log: () => {}, readEnvFile: () => '' });
  assert.equal(calls.filter(c => c.method === 'PUT' && c.url.includes('/media/')).length, 0);
  assert.equal(snapshot(local), before);
});

test('url= replaces the source, and equal tokens are refused before any request', async () => {
  const prod = await prodEnv();
  for (const n of (await exportOf(prod)).media) prod.MEDIA.files.set(n, await img(480, 600));
  const { fetchFn, calls } = world(prod, localEnv());
  await main(['url=https://staging.example/'], { fetchFn, env: { PROD_ADMIN_TOKEN: PROD_TOKEN, ADMIN_TOKEN: LOCAL_TOKEN }, log: () => {}, readEnvFile: () => '' });
  assert.ok(calls.some(c => c.url === 'https://staging.example/api/admin/export'));
  calls.length = 0;
  await assert.rejects(main([], { fetchFn, env: { PROD_ADMIN_TOKEN: 'same', ADMIN_TOKEN: 'same' }, log: () => {}, readEnvFile: () => '' }), /production token/);
  assert.equal(calls.length, 0);
  await assert.rejects(main([], { fetchFn, env: { ADMIN_TOKEN: LOCAL_TOKEN }, log: () => {}, readEnvFile: () => '' }), /PROD_ADMIN_TOKEN/);
});

test('import and media PUT are 404 on Render even in development from loopback; clientIp trusts the header there', async () => {
  const env = localEnv({ RENDER: 'true' });
  const exported = await exportOf(await prodEnv());
  assert.equal((await importTo(env, exported)).status, 404);
  const raw = await img(480, 600);
  assert.equal((await send(env, 'PUT', '/api/admin/media/000000000000000000000001-480.webp', { ip: '127.0.0.1', headers: auth(LOCAL_TOKEN), raw })).status, 404);
  const req = { headers: { 'x-forwarded-for': '1.2.3.4' }, socket: { remoteAddress: '127.0.0.1' } };
  assert.equal(clientIp(req, { RENDER: 'true' }), '1.2.3.4');
});

test('import refuses an eraOrder naming eras that are not imported', async () => {
  const env = localEnv();
  const good = await exportOf(await prodEnv());
  assert.equal((await importTo(env, { ...good, eraOrder: [...good.eraOrder, 'ghost'] })).status, 400);
  assert.equal(env.ORDERS.store.has(REV_KEY), false);
});

test('pull skips bad media names, and a 401 or 404 from the source gets a specific message', async () => {
  const prod = await prodEnv();
  for (const n of (await exportOf(prod)).media) prod.MEDIA.files.set(n, await img(480, 600));
  const { fetchFn } = world(prod, localEnv());
  const evil = async (url, init) => {
    const res = await fetchFn(url, init);
    if (!url.endsWith('/api/admin/export')) return res;
    const body = await res.json();
    return new Response(JSON.stringify({ ...body, media: [...body.media, '../x', 'a b.webp'] }), { status: 200 });
  };
  const out = [];
  const env = { PROD_ADMIN_TOKEN: PROD_TOKEN, ADMIN_TOKEN: LOCAL_TOKEN };
  await main([], { fetchFn: evil, env, log: l => out.push(l), readEnvFile: () => '' });
  assert.match(out[0], /2 skipped/);
  const status = code => async () => new Response(null, { status: code });
  await assert.rejects(main([], { fetchFn: status(401), env, log: () => {}, readEnvFile: () => '' }), /PROD_ADMIN_TOKEN/);
  await assert.rejects(main([], { fetchFn: status(404), env, log: () => {}, readEnvFile: () => '' }), /no export endpoint/);
});
