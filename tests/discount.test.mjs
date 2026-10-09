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
  assert.equal(apiBase({ local: true, url: null }), LOCAL_URL);
  assert.equal(apiBase({ local: false, url: 'https://evincus-dev.jojo6550.deno.net/' }), 'https://evincus-dev.jojo6550.deno.net');
});

test('adminToken reads the environment first, then .env', () => {
  assert.equal(adminToken({ ADMIN_TOKEN: 'from-env' }, () => 'ADMIN_TOKEN=from-file'), 'from-env');
  assert.equal(adminToken({}, () => 'X=1\nADMIN_TOKEN="from-file"\n'), 'from-file');
  assert.equal(adminToken({}, () => 'ADMIN_TOKEN=plain\r\nY=2'), 'plain');
  assert.throws(() => adminToken({}, () => { throw new Error('no file'); }), /ADMIN_TOKEN/);
  assert.throws(() => adminToken({}, () => 'ADMIN_TOKEN=\n'), /ADMIN_TOKEN/);
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
