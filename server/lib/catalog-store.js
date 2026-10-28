import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { photoPath, manifestEntry } from '../../data/photos.js';
import { imgPath } from '../../data/eras/merge.js';
import { lineKey } from '../../data/catalog.js';
import { storePhoto } from './media.js';
import { listAll, stockKey, stockEntry } from './stock.js';

export const REV_KEY = 'catalog:rev';
export const eraKey = slug => `era:${slug}`;
export const productKey = id => `product:${id}`;
const SEED_BATCH = 9; // keys per seed commit: each is guarded by kvStore, plus the REV_KEY check, within @deno/kv's 10

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
    era: { ...era, hero: path(era.hero) },
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
  const [eraRecs, productRecs] = await Promise.all([read('era:'), read('product:')]);
  const media = {};
  const eras = [];
  const products = [];
  // Eras follow eraOrder and products their position, so the store keeps the owner's order, not key order.
  const rank = slug => { const i = head.eraOrder.indexOf(slug); return i < 0 ? Infinity : i; };
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
      for (const c of p.colors) for (const size of p.sizes) {
        skus[`${c.name}|${size}`] = defaultSku(id, c.name, size, taken);
        taken.add(skus[`${c.name}|${size}`]);
        puts.push({ key: stockKey(lineKey(id, c.name, size)), ...stockEntry(soldOut || soldOutVariants.includes(`${c.name}|${size}`) ? 0 : seedStock, 0) });
      }
      const rec = {
        id, era: era.slug, ...p,
        ...(p.images && { images: await Promise.all(p.images.map(f => photo(era.slug, f))) }),
        colors: await Promise.all(p.colors.map(async c => (c.images ? { ...c, images: await Promise.all(c.images.map(f => photo(era.slug, f))) } : c))),
        skus, status: 'active', costCents: 0, continueSelling: false, lowStockAt: 3, position,
      };
      puts.push({ key: productKey(id), value: JSON.stringify(rec) });
    }
  }
  // @deno/kv allows 10 checks per commit and kvStore adds one per written key, so records go in batches. Until
  // REV_KEY lands nothing reads them and a rerun rewrites them; each batch re-checks it, so none lands after a seed.
  const unseeded = [{ key: REV_KEY, version: null }];
  for (let i = 0; i < puts.length; i += SEED_BATCH) {
    if (!await kv.commit({ checks: unseeded, puts: puts.slice(i, i + SEED_BATCH) })) return false;
  }
  return kv.commit({ checks: unseeded, puts: [{ key: REV_KEY, value: JSON.stringify({ rev: crypto.randomUUID(), eraOrder: modules.map(m => m.era.slug) }) }] });
}
