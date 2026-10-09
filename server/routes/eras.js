import { publicView, publicSales, eraSummary, eraDetail, cacheSeconds } from '../../data/catalog.js';
import { json, fail } from '../lib/http.js';

// Never cached past the next drop, era end, or sale start or end.
const boundaries = data => [...data.eras, ...(data.sales ?? []).map(s => ({ dropsAt: s.startsAt, endsAt: s.endsAt }))];
export const catalogCache = c => ({ 'Cache-Control': `public, max-age=${cacheSeconds(boundaries(c.data), c.now)}` });

export function listEras(req, c) {
  const v = publicView(c.data, c.now);
  c.log.info('era.list', { count: v.eras.length });
  return json({ now: c.now.toISOString(), eras: v.eras.map(e => eraSummary(e, v.products)), sales: publicSales(c.data.sales, c.now) }, 200, catalogCache(c));
}

export function getEra(req, c) {
  const v = publicView(c.data, c.now);
  const era = v.eras.find(e => e.slug === c.params[0]);
  if (!era) return fail(c, 'unknown-era', 404);
  const products = era.status === 'upcoming' ? [] : v.products.filter(p => p.era === era.slug);
  return json({ ...eraDetail(era), products }, 200, catalogCache(c));
}
