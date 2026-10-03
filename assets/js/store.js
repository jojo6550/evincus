// The site's copy of the catalog. Loaded once at startup; pages read it synchronously after that.
import { publicView, findProduct as find } from '../../data/catalog.js';

let state = { eras: [], products: [], site: { categories: [], lookbook: [], careNote: '' }, live: false };

async function fetchJson(file) {
  const res = await fetch(new URL(`../../data/${file}`, import.meta.url));
  if (!res.ok) throw new Error(`${file} failed to load (${res.status})`);
  return res.json();
}

export async function loadCatalog() {
  const [eras, products, site] = await Promise.all(['eras.json', 'products.json', 'site.json'].map(fetchJson));
  const view = publicView({ eras, products }, new Date());
  state = { eras: view.eras, products: view.products, site, live: false };
}

export const eras = () => state.eras;
export const products = () => state.products;
export const site = () => state.site;
export const isLive = () => state.live;
export const findProduct = id => find(state.products, id);
export const eraName = slug => state.eras.find(e => e.slug === slug)?.name ?? '';
