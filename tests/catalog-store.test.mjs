import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { ERAS } from '../data/eras/index.js';
import manifest from '../assets/js/image-manifest.js';
import { seedCatalog, loadCatalog, defaultSku, validateProduct, validateEra, REV_KEY, ERA_ORDER_KEY, eraKey, productKey } from '../server/lib/catalog-store.js';
import { loadStock, stockKey, stockDoc } from '../server/lib/stock.js';
import { makeEnv, fakeKV, fakeMedia } from './helpers/fake-env.mjs';

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
  for (let i = 0; i < 5; i++) await kv.put(stockKey(`extra-${i}`), stockDoc(new Map([['c|M', { onHand: i, committed: 1 }]])));
  await seedCatalog(env, { modules: ERAS, manifest, root, seedStock: 4 });
  const stock = await loadStock(env);
  for (let i = 0; i < 5; i++) assert.deepEqual(stock.get(`extra-${i}|c|M`), { onHand: i, committed: 1 });
  assert.equal((await loadCatalog(env)).products.length, ERAS.flatMap(m => m.products).length);
});

test('seedCatalog writes one stock document per product, holding every variant', async () => {
  const env = fresh(fakeKV());
  await seedCatalog(env, { modules: ERAS, manifest, root, seedStock: 3 });
  const tee = ERAS.flatMap(m => m.products).find(p => p.id === '99-tee');
  const doc = await env.ORDERS.get(stockKey('99-tee'), 'json');
  assert.deepEqual(Object.keys(doc).sort(), tee.colors.flatMap(c => tee.sizes.map(s => `${c.name}|${s}`)).sort());
  assert.deepEqual(doc['Classic Black|M'], { onHand: 3, committed: 0 });
  assert.equal(env.ORDERS.store.get(stockKey('99-tee')).opts.metadata, undefined);
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

test('the seeded catalog keeps the era files\' era and product order', async () => {
  const env = fresh();
  await seedCatalog(env, { modules: ERAS, manifest, root, seedStock: 1 });
  const cat = await loadCatalog(env);
  assert.deepEqual(cat.products.map(p => p.id), ERAS.flatMap(m => m.products.map(p => p.id)));
  assert.deepEqual(cat.products.filter(p => p.era === 'core').map(p => p.position), ERAS.find(m => m.era.slug === 'core').products.map((_, i) => i));
});

test('defaultSku follows the colour-code rule and avoids clashes', () => {
  assert.equal(defaultSku('99-tee', 'Classic Black', 'M', new Set()), '99-TEE-BLK-M');
  assert.equal(defaultSku('99-tee', 'Lucent White', '2XL', new Set()), '99-TEE-WHT-2XL');
  assert.equal(defaultSku('99-tee', 'Classic Black', 'M', new Set(['99-TEE-BLK-M'])), '99-TEE-BLK-M-2');
  assert.equal(defaultSku('99-tee', 'Classic Black', 'M', new Set(['99-TEE-BLK-M', '99-TEE-BLK-M-2'])), '99-TEE-BLK-M-3');
});

test('seedCatalog writes the era order to its own key, and every seeded era and product passes the save rules', async () => {
  const env = fresh();
  await seedCatalog(env, { modules: ERAS, manifest, root, seedStock: 0 });
  assert.deepEqual(await env.ORDERS.get(ERA_ORDER_KEY, 'json'), ERAS.map(m => m.era.slug));
  assert.deepEqual(Object.keys(await env.ORDERS.get(REV_KEY, 'json')), ['rev']);
  const cat = await loadCatalog(env);
  for (const m of ERAS) {
    assert.deepEqual(validateEra(await env.ORDERS.get(eraKey(m.era.slug), 'json')), [], m.era.slug);
    for (const { id } of m.products) {
      const doc = await env.ORDERS.get(productKey(id), 'json');
      assert.deepEqual(validateProduct(doc, { eras: cat.eras, products: cat.products, stock: {}, current: doc }), [], id);
    }
  }
});

test('loadCatalog orders eras by catalog:era-order, falling back to catalog:rev for data seeded before it', async () => {
  const env = fresh();
  await seedCatalog(env, { modules: ERAS, manifest, root, seedStock: 0 });
  const slugs = ERAS.map(m => m.era.slug);
  await env.ORDERS.delete(ERA_ORDER_KEY);
  await env.ORDERS.put(REV_KEY, JSON.stringify({ rev: 'legacy', eraOrder: [...slugs].reverse() }));
  assert.deepEqual((await loadCatalog(env)).eras.map(e => e.slug), [...slugs].reverse());
  await env.ORDERS.put(ERA_ORDER_KEY, JSON.stringify(slugs));
  await env.ORDERS.put(REV_KEY, JSON.stringify({ rev: 'next', eraOrder: [...slugs].reverse() }));
  assert.deepEqual((await loadCatalog(env)).eras.map(e => e.slug), slugs);
});
