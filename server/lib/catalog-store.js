import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { photoPath, manifestEntry } from '../../data/photos.js';
import { imgPath } from '../../data/eras/merge.js';
import { storePhoto } from './media.js';
import { listAll, stockKey, stockDoc } from './stock.js';

// { rev }, replaced blind by every catalog write so each process reloads; never checked, so saves never clash on it.
export const REV_KEY = 'catalog:rev';
// [slug…], newest first. Its own key, so a product save can't undo a concurrent reorder.
export const ERA_ORDER_KEY = 'catalog:era-order';
export const eraKey = slug => `era:${slug}`;
export const productKey = id => `product:${id}`;
// Puts per seed commit, within @deno/kv's 1000 mutations; new keys are unguarded, so the only check is REV_KEY's.
// shortcut: batches count puts, not bytes (@deno/kv caps a commit at 800 KiB); split by size if seeds near ~700 KB
const SEED_BATCH = 900;

// SKU colour code: last word, vowels dropped after its first letter, "ck" read as "k", first 3 letters.
const colorCode = color => {
  const w = color.trim().split(/\s+/).at(-1).toUpperCase();
  return (w[0] + w.slice(1).replace(/CK/g, 'K').replace(/[AEIOU]/g, '')).slice(0, 3);
};

export function defaultSku(productId, color, size, taken) {
  const base = `${productId}-${colorCode(color)}-${size}`.toUpperCase();
  let sku = base;
  for (let n = 2; taken.has(sku); n++) sku = `${base}-${n}`;
  return sku;
}

// Photo refs in stored records become media paths; every ref lands in `media`.
function resolve(era, products) {
  const media = {};
  const path = ref => { const p = photoPath(ref); media[p] = manifestEntry(ref); return p; };
  return {
    media,
    era: { ...era, hero: era.hero && path(era.hero) }, // a new draft era has no hero yet
    products: products.map(p => ({
      ...p,
      ...(p.images && { images: p.images.map(path) }),
      colors: p.colors.map(c => (c.images ? { ...c, images: c.images.map(path) } : c)),
    })),
  };
}

const cache = new WeakMap(); // per ORDERS store, so tests with separate stores do not share

export async function loadCatalog(env) {
  const kv = env.ORDERS;
  const head = await kv.get(REV_KEY, 'json');
  if (!head) return { eras: [], products: [], media: {}, rev: null };
  const hit = cache.get(kv);
  if (hit?.rev === head.rev) return hit;
  const read = async prefix => Promise.all((await listAll(kv, prefix)).map(({ name }) => kv.get(name, 'json')));
  const [eraRecs, productRecs, order] = await Promise.all([read('era:'), read('product:'), kv.get(ERA_ORDER_KEY, 'json')]);
  const eraOrder = order ?? head.eraOrder ?? []; // data seeded before ERA_ORDER_KEY keeps its order in REV_KEY
  const media = {};
  const eras = [];
  const products = [];
  // Eras follow eraOrder and products their position, so the store keeps the owner's order, not key order.
  const rank = slug => { const i = eraOrder.indexOf(slug); return i < 0 ? Infinity : i; };
  const position = p => p.position ?? Number.MAX_SAFE_INTEGER;
  for (const rec of eraRecs.filter(Boolean).sort((a, b) => rank(a.slug) - rank(b.slug))) {
    const r = resolve(rec, productRecs.filter(p => p?.era === rec.slug).sort((a, b) => position(a) - position(b)));
    Object.assign(media, r.media);
    eras.push(r.era);
    products.push(...r.products);
  }
  const out = { eras, products, media, rev: head.rev };
  cache.set(kv, out);
  return out;
}

// Imports the era files once. Returns false when the catalog already exists.
export async function seedCatalog(env, { modules, manifest, root, seedStock }) {
  const kv = env.ORDERS;
  if ((await kv.getEntry(REV_KEY)).version !== null) return false;
  const media = env.MEDIA;
  const refs = new Map(); // manifest key → photo ref, so a shared file is stored once
  const photo = async (slug, file) => {
    const key = imgPath(slug, file);
    if (!refs.has(key)) {
      const entry = manifest[key];
      if (!entry) throw new Error(`No manifest entry for ${key}`);
      refs.set(key, await storePhoto(media, await Promise.all(entry.variants.map(async v => new Uint8Array(await readFile(join(root, v.src)))))));
    }
    return refs.get(key);
  };
  const puts = [];
  const taken = new Set();
  for (const { era, products } of modules) {
    puts.push({ key: eraKey(era.slug), value: JSON.stringify({ ...era, hero: await photo(era.slug, era.hero), state: 'published' }) });
    for (const [position, { id, soldOut, soldOutVariants = [], ...p }] of products.entries()) {
      const skus = {};
      const stock = {};
      for (const c of p.colors) for (const size of p.sizes) {
        const variant = `${c.name}|${size}`;
        skus[variant] = defaultSku(id, c.name, size, taken);
        taken.add(skus[variant]);
        stock[variant] = { onHand: soldOut || soldOutVariants.includes(variant) ? 0 : seedStock, committed: 0 };
      }
      puts.push({ key: stockKey(id), value: stockDoc(stock) });
      const rec = {
        id, era: era.slug, ...p,
        ...(p.images && { images: await Promise.all(p.images.map(f => photo(era.slug, f))) }),
        colors: await Promise.all(p.colors.map(async c => (c.images ? { ...c, images: await Promise.all(c.images.map(f => photo(era.slug, f))) } : c))),
        skus, status: 'active', costCents: 0, continueSelling: false, lowStockAt: 3, position,
      };
      puts.push({ key: productKey(id), value: JSON.stringify(rec) });
    }
  }
  // Records go in batches. Until REV_KEY lands nothing reads them and a rerun rewrites them; each batch re-checks
  // it, so none lands after a seed.
  const unseeded = [{ key: REV_KEY, version: null }];
  for (let i = 0; i < puts.length; i += SEED_BATCH) {
    if (!await kv.commit({ checks: unseeded, puts: puts.slice(i, i + SEED_BATCH) })) return false;
  }
  return kv.commit({ checks: unseeded, puts: [
    { key: ERA_ORDER_KEY, value: JSON.stringify(modules.map(m => m.era.slug)) },
    { key: REV_KEY, value: JSON.stringify({ rev: crypto.randomUUID() }) },
  ] });
}

const DATA_PREFIXES = ['era:', 'product:', 'stock:'];
// Mutations per import commit; @deno/kv allows 1000, the margin keeps commits small.
export const IMPORT_BATCH = 400;
const isRef = r => r && typeof r === 'object' && Array.isArray(r.widths);

// Only catalog data (eras, products, stock) and the photo names they use; never orders, accounts, sessions or logs.
export async function exportCatalog(env) {
  const kv = env.ORDERS;
  const head = await kv.get(REV_KEY, 'json');
  const out = { rev: head?.rev ?? null, eraOrder: (await kv.get(ERA_ORDER_KEY, 'json')) ?? head?.eraOrder ?? [], eras: [], products: [], stock: [], media: [] };
  const media = new Set();
  for (const [prefix, list] of [['era:', out.eras], ['product:', out.products], ['stock:', out.stock]]) {
    for (const { name } of await listAll(kv, prefix)) {
      const value = await kv.get(name);
      if (value === null) continue; // deleted since the listing
      list.push({ key: name, value });
      if (prefix === 'stock:') continue;
      const doc = JSON.parse(value);
      for (const r of [doc.hero, ...(doc.images ?? []), ...(doc.colors ?? []).flatMap(c => c.images ?? [])]) {
        if (isRef(r)) for (const w of r.widths) media.add(`${r.id}-${w}.${r.ext}`);
      }
    }
  }
  out.media = [...media].sort();
  return out;
}

// Makes the catalog keys equal the export and touches nothing else. REV_KEY goes in its own last commit, so this
// process's catalog cache reloads only once all the data is in. Running it twice leaves the same data.
export async function importCatalog(env, { eraOrder, eras, products, stock }) {
  const kv = env.ORDERS;
  const incoming = [...eras, ...products, ...stock];
  const keep = new Set(incoming.map(e => e.key));
  const deletes = [];
  for (const prefix of DATA_PREFIXES) for (const { name } of await listAll(kv, prefix)) if (!keep.has(name)) deletes.push(name);
  const muts = [...deletes.map(key => ({ del: key })), ...incoming];
  for (let i = 0; i < muts.length; i += IMPORT_BATCH) {
    const part = muts.slice(i, i + IMPORT_BATCH);
    await kv.commit({ puts: part.filter(m => !m.del), deletes: part.filter(m => m.del).map(m => m.del) });
  }
  await kv.commit({ puts: [
    { key: ERA_ORDER_KEY, value: JSON.stringify(eraOrder) },
    { key: REV_KEY, value: JSON.stringify({ rev: crypto.randomUUID() }) },
  ] });
  return { eras: eras.length, products: products.length, stock: stock.length, removed: deletes.length };
}
