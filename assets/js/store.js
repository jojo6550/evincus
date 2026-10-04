// The site's copy of the catalog. Loaded once at startup; pages read it synchronously after that.
// The API is the source of truth. If it can't be reached, the bundled era catalog keeps browsing working,
// with every product marked unbuyable so checkout stays off.
import { publicView, findProduct as find } from '../../data/catalog.js';
import { api, beaconOnce } from './api.js';

const DEFAULT_SITE = { categories: [], lookbook: [], careNote: '' };

let state = { eras: [], products: [], site: DEFAULT_SITE, live: false };

async function fetchJson(file) {
  const res = await fetch(new URL(`../../data/${file}`, import.meta.url));
  if (!res.ok) throw new Error(`${file} failed to load (${res.status})`);
  return res.json();
}

async function fromApi() {
  const list = await api('GET', '/api/eras');
  const released = list.eras.filter(e => e.status !== 'upcoming');
  const details = await Promise.all(released.map(e => api('GET', `/api/eras/${encodeURIComponent(e.slug)}`)));
  const bySlug = new Map(details.map(({ products, ...era }) => [era.slug, era]));
  return {
    eras: list.eras.map(e => ({ ...e, ...(bySlug.get(e.slug) ?? {}) })),
    products: details.flatMap(d => d.products),
  };
}

// Loaded only here, so visitors on the normal path never download the era modules.
async function fromStatic() {
  const { CATALOG } = await import('../../data/eras/index.js');
  const view = publicView(CATALOG, new Date());
  return { eras: view.eras, products: view.products.map(p => ({ ...p, buyable: false })) };
}

export async function loadCatalog() {
  // Site copy is decoration; without it the store still has to render.
  const site = await fetchJson('site.json').catch(err => {
    console.error(err);
    return DEFAULT_SITE;
  });
  try {
    state = { ...(await fromApi()), site, live: true };
  } catch {
    beaconOnce('api-unreachable');
    state = { ...(await fromStatic()), site, live: false };
  }
}

export const eras = () => state.eras;
export const products = () => state.products;
export const site = () => state.site;
export const isLive = () => state.live;
export const findProduct = id => find(state.products, id);
export const eraName = slug => state.eras.find(e => e.slug === slug)?.name ?? '';
