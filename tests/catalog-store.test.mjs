import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { ERAS } from '../data/eras/index.js';
import manifest from '../assets/js/image-manifest.js';
import { seedCatalog, loadCatalog, defaultSku, REV_KEY } from '../server/lib/catalog-store.js';
import { loadStock, stockEntry } from '../server/lib/stock.js';
import { makeEnv, fakeKV, fakeMedia } from './helpers/fake-env.mjs';
import { skip, fileKv } from './helpers/deno-kv.mjs';
import { kvStore } from '../server/lib/kv-store.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const fresh = (kv = fakeKV()) => makeEnv({ ORDERS: kv, MEDIA: fakeMedia() });
const countLists = kv => { const n = { lists: 0 }; const list = kv.list.bind(kv); kv.list = async a => { n.lists++; return list(a); }; return n; };

test('seedCatalog imports the era files once, with photos, published eras, active products and seeded stock', async () => {
  const env = fresh();
  assert.equal(await seedCatalog(env, { modules: ERAS, manifest, root, seedStock: 10 }), true);
  assert.equal(await seedCatalog(env, { modules: ERAS, manifest, root, seedStock: 10 }), false);
  const cat = await loadCatalog(env);
  const tee = cat.products.find(p => p.id === '99-tee');
  assert.equal(tee.status, 'active');
  assert.match(tee.colors[0].images[0], /^media\/[0-9a-f]{24}-\d+\.webp$/);
  assert.ok(cat.media[cat.products[0].colors[0].images?.[0] ?? cat.products[0].images[0]].variants.length >= 2);
  assert.equal((await loadStock(env)).get('99-tee|Classic Black|M').onHand, 10);
  assert.deepEqual(cat.eras.map(e => e.slug), ERAS.map(m => m.era.slug));
  assert.ok(cat.eras.every(e => e.state === 'published' && /^media\//.test(e.hero)));
  assert.equal(tee.skus['Lucent White|2XL'], '99-TEE-WHT-2XL');
  assert.ok(cat.products.every(p => !('soldOut' in p) && p.costCents === 0 && p.lowStockAt === 3 && p.continueSelling === false));
});

test('seedCatalog does nothing when the catalog rev key already exists', async () => {
  const env = fresh();
  await env.ORDERS.put(REV_KEY, JSON.stringify({ rev: 'x', eraOrder: [] }));
  assert.equal(await seedCatalog(env, { modules: ERAS, manifest, root, seedStock: 10 }), false);
  assert.equal((await env.MEDIA.list()).length, 0);
});

test('loadCatalog reloads only when catalog:rev changes', async () => {
  const env = fresh();
  await seedCatalog(env, { modules: ERAS, manifest, root, seedStock: 1 });
  const n = countLists(env.ORDERS);
  const a = await loadCatalog(env);
  const b = await loadCatalog(env);
  assert.equal(n.lists, 2); // era: and product:, once
  assert.equal(b, a);
  const head = await env.ORDERS.get(REV_KEY, 'json');
  await env.ORDERS.put(REV_KEY, JSON.stringify({ ...head, rev: 'next' }));
  assert.equal((await loadCatalog(env)).rev, 'next');
  assert.equal(n.lists, 4);
});

test('loadStock and loadCatalog follow list cursors', async () => {
  const kv = fakeKV({ pageSize: 2 });
  const env = fresh(kv);
  for (let i = 0; i < 5; i++) { const { value, opts } = stockEntry(i, 0); await kv.put(`stock:extra|c|${i}`, value, opts); }
  await seedCatalog(env, { modules: ERAS, manifest, root, seedStock: 4 });
  const stock = await loadStock(env);
  for (let i = 0; i < 5; i++) assert.equal(stock.get(`extra|c|${i}`).onHand, i);
  assert.equal((await loadCatalog(env)).products.length, ERAS.flatMap(m => m.products).length);
});

test('seedCatalog seeds sold-out products and variants at 0 whatever seedStock is, and does not store the flags', async () => {
  const base = ERAS.find(m => m.era.slug === 'core');
  const [a, b] = base.products;
  const mod = { era: base.era, products: [
    { ...a, soldOut: true, soldOutVariants: [] },
    { ...b, soldOut: false, soldOutVariants: ['Classic Black|M'] },
  ] };
  const env = fresh();
  await seedCatalog(env, { modules: [mod], manifest, root, seedStock: 10 });
  const stock = await loadStock(env);
  assert.equal(stock.get(`${a.id}|Classic Black|S`).onHand, 0);
  assert.equal(stock.get(`${a.id}|Lucent White|XL`).onHand, 0);
  assert.equal(stock.get(`${b.id}|Classic Black|M`).onHand, 0);
  assert.equal(stock.get(`${b.id}|Classic Black|L`).onHand, 10);
  assert.equal(stock.get(`${b.id}|Lucent White|M`).onHand, 10);
  assert.ok((await loadCatalog(env)).products.every(p => !('soldOut' in p) && !('soldOutVariants' in p)));
});

// File-backed @deno/kv allows 10 checks per commit and kvStore guards every key it writes; the real catalog has 140 keys.
test('seedCatalog seeds the real era files into real Deno KV', { skip }, async t => {
  const env = { ORDERS: kvStore(await fileKv(t)), MEDIA: fakeMedia() };
  assert.equal(await seedCatalog(env, { modules: ERAS, manifest, root, seedStock: 10 }), true);
  assert.equal((await loadCatalog(env)).products.length, ERAS.flatMap(m => m.products).length);
  assert.equal((await loadStock(env)).size, ERAS.flatMap(m => m.products).reduce((n, p) => n + p.colors.length * p.sizes.length, 0));
  assert.equal(await seedCatalog(env, { modules: ERAS, manifest, root, seedStock: 10 }), false);
});

test('defaultSku follows the colour-code rule and avoids clashes', () => {
  assert.equal(defaultSku('99-tee', 'Classic Black', 'M', new Set()), '99-TEE-BLK-M');
  assert.equal(defaultSku('99-tee', 'Lucent White', '2XL', new Set()), '99-TEE-WHT-2XL');
  assert.equal(defaultSku('99-tee', 'Classic Black', 'M', new Set(['99-TEE-BLK-M'])), '99-TEE-BLK-M-2');
  assert.equal(defaultSku('99-tee', 'Classic Black', 'M', new Set(['99-TEE-BLK-M', '99-TEE-BLK-M-2'])), '99-TEE-BLK-M-3');
});
