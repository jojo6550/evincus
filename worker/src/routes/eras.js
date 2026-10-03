import { publicView, eraSummary, eraDetail, cacheSeconds } from '../../../data/catalog.js';
import { json, fail } from '../lib/http.js';

export const catalogCache = c => ({ 'Cache-Control': `public, max-age=${cacheSeconds(c.data.eras, c.now)}` });

export function listEras(req, c) {
  const v = publicView(c.data, c.now);
  c.log.info('era.list', { count: v.eras.length });
  return json({ now: c.now.toISOString(), eras: v.eras.map(e => eraSummary(e, v.products)) }, 200, catalogCache(c));
}

export function getEra(req, c) {
  const v = publicView(c.data, c.now);
  const era = v.eras.find(e => e.slug === c.params[0]);
  if (!era) return fail(c, 'unknown-era', 404);
  const products = era.status === 'upcoming' ? [] : v.products.filter(p => p.era === era.slug);
  return json({ ...eraDetail(era), products }, 200, catalogCache(c));
}
