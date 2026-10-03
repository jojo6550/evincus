import { publicView } from '../../../data/catalog.js';
import { json, fail } from '../lib/http.js';
import { catalogCache } from './eras.js';

// Unreleased products answer exactly like missing ones.
export function getProduct(req, c) {
  const v = publicView(c.data, c.now);
  const p = v.products.find(x => x.id === c.params[0]);
  if (!p) return fail(c, 'unknown-product', 404);
  const era = v.eras.find(e => e.slug === p.era);
  return json({ ...p, era: { slug: era.slug, name: era.name, status: era.status } }, 200, catalogCache(c));
}
