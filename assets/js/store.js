// The site's copy of the catalog. Loaded once at startup; pages read it synchronously after that.
// The API is the source of truth. If it can't be reached, the bundled era catalog keeps browsing working,
// with every product marked unbuyable so checkout stays off.
import { publicView, findProduct as find } from '../../data/catalog.js';
import { api, beaconOnce } from './api.js';

const DEFAULT_SITE = { categories: [], lookbook: [], careNote: '' };

// Shirts, then sweaters and jackets, then pants, on every page. Array sort is stable, so era order holds within a group.
const CATEGORY_ORDER = ['tees', 'outerwear', 'bottoms'];
const rank = p => { const i = CATEGORY_ORDER.indexOf(p.category); return i < 0 ? CATEGORY_ORDER.length : i; };
const byCategory = list => [...list].sort((a, b) => rank(a) - rank(b));

let state = { eras: [], products: [], sales: [], skewMs: 0, site: DEFAULT_SITE, live: false };

async function fetchJson(file) {
  const res = await fetch(new URL(`../../data/${file}`, import.meta.url), { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`${file} failed to load (${res.status})`);
  return res.json();
}

// One request, already in flight from the page's <link rel="preload"> by the time this module runs.
async function fromApi() {
  const { now, eras, products, sales } = await api('GET', '/api/catalog');
  return { eras, products, sales: sales ?? [], skewMs: Date.parse(now) - Date.now() || 0 };
}

// Loaded only here, so visitors on the normal path never download the era modules.
async function fromStatic() {
  const { CATALOG } = await import('../../data/eras/index.js');
  const view = publicView(CATALOG, new Date());
  return { eras: view.eras, products: view.products.map(p => ({ ...p, buyable: false })), sales: [] };
}

export async function loadCatalog() {
  // Site copy is decoration; without it the store still has to render.
  const sitePromise = fetchJson('site.json').catch(err => {
    console.error(err);
    return DEFAULT_SITE;
  });
  try {
    const loaded = await fromApi();
    state = { ...loaded, products: byCategory(loaded.products), site: await sitePromise, live: true };
  } catch {
    beaconOnce('api-unreachable');
    const loaded = await fromStatic();
    state = { ...loaded, products: byCategory(loaded.products), site: await sitePromise, live: false };
  }
}

export const eras = () => state.eras;
export const products = () => state.products;
export const site = () => state.site;
export const sales = () => state.sales;
// The API's clock, so sale countdowns end when the API says, not when this device does.
export const serverNow = () => Date.now() + state.skewMs;
export const isLive = () => state.live;
export const findProduct = id => find(state.products, id);
export const eraName = slug => state.eras.find(e => e.slug === slug)?.name ?? '';
