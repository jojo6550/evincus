// Real file-backed Deno KV: it enforces the per-commit limits (10 checks, 1000 mutations) that memory KV and fakeKV skip.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { ERAS } from '../data/eras/index.js';
import manifest from '../assets/js/image-manifest.js';
import { skip, fileKv } from './helpers/deno-kv.mjs';
import { fakeKV, fakeMedia } from './helpers/fake-env.mjs';
import { kvStore, CHUNK } from '../server/lib/kv-store.js';
import { seedCatalog, loadCatalog } from '../server/lib/catalog-store.js';
import { loadStock, listAll, stockKey, stockDoc } from '../server/lib/stock.js';
import { submitOrder } from '../server/lib/submissions.js';

const root = fileURLToPath(new URL('..', import.meta.url));

async function raw(kv, prefix) {
  const out = [];
  for await (const e of kv.list({ prefix })) out.push(e);
  return out;
}

test('a commit writing 50 unchunked keys with one explicit check succeeds', { skip }, async t => {
  const s = kvStore(await fileKv(t));
  await s.put('k:0', 'old');
  const puts = Array.from({ length: 50 }, (_, i) => ({ key: `k:${i}`, value: String(i) }));
  assert.equal(await s.commit({ checks: [{ key: 'guard', version: null }], puts }), true);
  assert.equal(await s.get('k:0'), '0');
  assert.equal(await s.get('k:49'), '49');
});

test('a chunked key is still guarded: a concurrent rewrite of it makes the commit retry, never orphaning the current chunk set', { skip }, async t => {
  const kv = await fileKv(t);
  const s = kvStore(kv);
  await s.put('big', 'a'.repeat(2 * CHUNK));
  // Another writer replaces `big` with a new chunk set right after commit() has read its head.
  let interfered = false;
  let commits = 0;
  const racing = kvStore({
    get: key => kv.get(key),
    getMany: async keys => {
      const entries = await kv.getMany(keys);
      if (!interfered) { interfered = true; await s.put('big', 'b'.repeat(2 * CHUNK)); }
      return entries;
    },
    atomic: () => { commits++; return kv.atomic(); },
  });
  assert.equal(await racing.commit({ puts: [{ key: 'big', value: 'small' }] }), true);
  assert.equal(commits, 2);
  assert.equal(await s.get('big'), 'small');
  assert.deepEqual(await raw(kv, ['c']), []);
});

test('fakeKV refuses commits past the same limits, so unit tests catch them too', async () => {
  const kv = fakeKV();
  const checks = n => Array.from({ length: n }, (_, i) => ({ key: `c:${i}`, version: null }));
  const puts = n => Array.from({ length: n }, (_, i) => ({ key: `p:${i}`, value: '1' }));
  assert.equal(await kv.commit({ checks: checks(10), puts: puts(999), deletes: ['d'] }), true);
  await assert.rejects(kv.commit({ checks: checks(11) }), /TooManyChecks/);
  await assert.rejects(kv.commit({ puts: puts(1000), deletes: ['d'] }), /TooManyMutations/);
});

test('seeding the real era files into file-backed KV succeeds and writes one stock document per product', { skip }, async t => {
  const env = { ORDERS: kvStore(await fileKv(t)), MEDIA: fakeMedia() };
  const products = ERAS.flatMap(m => m.products);
  assert.equal(await seedCatalog(env, { modules: ERAS, manifest, root, seedStock: 10 }), true);
  assert.equal((await loadCatalog(env)).products.length, products.length);
  assert.deepEqual((await listAll(env.ORDERS, 'stock:')).map(k => k.name).sort(), products.map(p => `stock:${p.id}`).sort());
  assert.equal((await loadStock(env)).size, products.reduce((n, p) => n + p.colors.length * p.sizes.length, 0));
  assert.equal(await seedCatalog(env, { modules: ERAS, manifest, root, seedStock: 10 }), false);
});

test('an 8-product, 50-line checkout commits its order and stock in one file-backed commit', { skip }, async t => {
  const env = { ORDERS: kvStore(await fileKv(t)) };
  const lines = Array.from({ length: 50 }, (_, i) => ({ key: `p${i % 8}|C${i}|M`, id: `p${i % 8}`, color: `C${i}`, size: 'M', qty: 2 }));
  for (let p = 0; p < 8; p++) {
    await env.ORDERS.put(stockKey(`p${p}`), stockDoc(Object.fromEntries(lines.filter(l => l.id === `p${p}`).map(l => [`${l.color}|M`, { onHand: 2, committed: 0 }]))));
  }
  const record = { id: 'EV-1', placedAt: '2026-10-03T12:00:00.000Z', totalCents: 0, lines };
  assert.deepEqual(await submitOrder(env, 'EV-1', 'fp', record), { record });
  const stock = await loadStock(env);
  assert.ok(lines.every(l => stock.get(l.key).committed === 2));
  assert.equal((await listAll(env.ORDERS, 'adj:')).length, 50);
  assert.notEqual(await env.ORDERS.get('order:EV-1'), null);
});
