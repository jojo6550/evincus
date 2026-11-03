// The live catalog: eras, products and photos from KV (catalog-store.js), shop copy from data/site.json.
import { loadCatalog } from './catalog-store.js';
import site from '../../data/site.json' with { type: 'json' };

export const liveCatalog = async env => ({ ...await loadCatalog(env), site });
