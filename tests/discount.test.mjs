import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, makeCtx } from './helpers/fake-env.mjs';
import { FIXTURE, NOW } from './helpers/fixture.mjs';
import { createApp } from '../server/index.js';
import { PROD_URL, LOCAL_URL, apiBase, adminToken, readSales, writeSales } from '../scripts/discount.mjs';

const TOKEN = 'admin-test-token';
const iso = ms => new Date(ms).toISOString();
const sale = (over = {}) => ({ id: 's1', percent: 20, eras: ['alpha'], label: null, startsAt: iso(NOW), endsAt: iso(NOW + 3_600_000), ...over });

// A fetch that hands requests straight to the app, so the script and the route are tested together.
function appFetch(env) {
  const app = createApp({ data: FIXTURE, clock: () => NOW });
  return async (url, init) => {
    const ctx = makeCtx();
    const res = await app.fetch(new Request(url, init), env, ctx);
    await ctx.settle();
    return res;
  };
}

test('apiBase picks production, local, or a given URL without a trailing slash', () => {
  assert.equal(apiBase({ local: false, url: null }), PROD_URL);
  // evincus.shop redirects to www, and fetch drops Authorization on that cross-origin redirect.
  assert.equal(PROD_URL, 'https://www.evincus.shop');
  assert.equal(apiBase({ local: true, url: null }), LOCAL_URL);
  assert.equal(apiBase({ local: false, url: 'https://evincus.onrender.com/' }), 'https://evincus.onrender.com');
});

test('adminToken reads the environment first, then .env', () => {
  assert.equal(adminToken({ ADMIN_TOKEN: 'from-env' }, () => 'ADMIN_TOKEN=from-file'), 'from-env');
  assert.equal(adminToken({}, () => 'X=1\nADMIN_TOKEN="from-file"\n'), 'from-file');
  assert.equal(adminToken({}, () => 'ADMIN_TOKEN=plain\r\nY=2'), 'plain');
  assert.throws(() => adminToken({}, () => { throw new Error('no file'); }), /ADMIN_TOKEN/);
  assert.throws(() => adminToken({}, () => 'ADMIN_TOKEN=\n'), /ADMIN_TOKEN/);
  assert.throws(() => adminToken({}, () => 'ADMIN_TOKEN=\nRESEND_API_KEY=re_secret\n'), /ADMIN_TOKEN/);
  assert.throws(() => adminToken({}, () => 'ADMIN_TOKEN=\r\nRESEND_API_KEY=re_secret\r\n'), /ADMIN_TOKEN/);
  assert.equal(adminToken({}, () => "ADMIN_TOKEN='single'\n"), 'single');
  assert.equal(adminToken({}, () => 'ADMIN_TOKEN=spaced   \n'), 'spaced');
});

test('read and write go through the admin endpoint with the version that was read', async () => {
  const f = appFetch(makeEnv({ ADMIN_TOKEN: TOKEN }));
  const first = await readSales(PROD_URL, TOKEN, f);
  assert.deepEqual(first, { sales: [], version: null });
  await writeSales(PROD_URL, TOKEN, [sale()], first.version, f);
  assert.deepEqual((await readSales(PROD_URL, TOKEN, f)).sales, [sale()]);
});

test('a write after someone else changed the sales is refused with a clear message', async () => {
  const f = appFetch(makeEnv({ ADMIN_TOKEN: TOKEN }));
  const { version } = await readSales(PROD_URL, TOKEN, f);
  await writeSales(PROD_URL, TOKEN, [sale()], version, f);
  await assert.rejects(writeSales(PROD_URL, TOKEN, [sale({ id: 's2' })], version, f), /changed since/);
});

test('a wrong token or a server without ADMIN_TOKEN explains what to fix', async () => {
  await assert.rejects(readSales(PROD_URL, 'wrong', appFetch(makeEnv({ ADMIN_TOKEN: TOKEN }))), /refused the admin token/);
  await assert.rejects(readSales(PROD_URL, TOKEN, appFetch(makeEnv())), /no admin endpoint/);
});

test('an unreachable server says which URL and what to do', async () => {
  const down = async () => { throw new TypeError('fetch failed'); };
  await assert.rejects(readSales(LOCAL_URL, TOKEN, down), /Could not reach http:\/\/localhost:8000/);
});

test('discount checks era names against the server list', async () => {
  const { main } = await import('../scripts/discount.mjs');
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, method: init.method });
    if (url.endsWith('/eras')) return new Response(JSON.stringify({ eras: [{ slug: 'alpha', name: 'A', state: 'published' }] }), { status: 200 });
    if (init.method === 'GET') return new Response(JSON.stringify({ sales: [], version: null }), { status: 200 });
    return new Response('{}', { status: 200 });
  };
  const env = { ADMIN_TOKEN: TOKEN };
  await assert.rejects(main(['ghost', '1', '10', 'local'], { fetchFn, env, log() {} }), /Unknown era ghost\. Eras: alpha\./);
  await main(['alpha', '1', '10', 'local'], { fetchFn, env, log() {} });
  assert.ok(calls.some(c => c.url === 'http://localhost:8000/api/admin/eras'));
  assert.ok(calls.some(c => c.method === 'PUT'));
});

test('knownEras explains a malformed reply', async () => {
  const { knownEras } = await import('../scripts/discount.mjs');
  await assert.rejects(knownEras(PROD_URL, TOKEN, async () => new Response('{}', { status: 200 })), /eras that are not a list/);
});

test('knownEras explains a malformed reply', async () => {
  const { knownEras } = await import('../scripts/discount.mjs');
  await assert.rejects(knownEras(PROD_URL, TOKEN, async () => new Response('{}', { status: 200 })), /eras that are not a list/);
});
