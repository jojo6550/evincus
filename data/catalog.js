// Catalog rules shared by the site, the API and the tests. Pure: no I/O and no clock reads,
// so callers pass `now`. The API's clock is the one that decides what can be bought.

export const MAX_QTY = 10;

export const lineKey = (id, color, size) => `${id}|${color}|${size}`;

const time = iso => (iso ? Date.parse(iso) : null);

export function eraStatus(era, now) {
  const ms = +now;
  const drops = time(era.dropsAt);
  const ends = time(era.endsAt);
  if (drops !== null && ms < drops) return 'upcoming';
  if (ends !== null && ms >= ends) return 'archived';
  return 'live';
}

// How long a catalog response may be cached: never past the next drop or end.
export function cacheSeconds(eras, now, max = 60) {
  const ms = +now;
  const ahead = eras.flatMap(e => [time(e.dropsAt), time(e.endsAt)]).filter(t => t !== null && t > ms);
  if (!ahead.length) return max;
  return Math.max(0, Math.min(max, Math.floor((Math.min(...ahead) - ms) / 1000)));
}

const statusOf = (data, slug, now) => {
  const era = data.eras.find(e => e.slug === slug);
  return era ? eraStatus(era, now) : 'upcoming'; // a product pointing at a missing era is treated as unreleased
};

const isSoldOut = (p, color, size) =>
  p.soldOut === true || (p.soldOutVariants ?? []).includes(`${color}|${size}`);

// Status of one bag line. Checks run in this order so nothing leaks about unreleased products.
export function lineStatus(data, now, { id, color, size }) {
  const p = data.products.find(x => x.id === id);
  if (!p) return 'unknown-item';
  const era = statusOf(data, p.era, now);
  if (era === 'upcoming') return 'not-released';
  if (!p.sizes.includes(size) || !p.colors.some(c => c.name === color)) return 'unknown-item';
  if (era === 'archived') return 'era-ended';
  if (isSoldOut(p, color, size)) return 'sold-out';
  return 'ok';
}

// What a shopper may see at `now`: every era with its status, and products of released eras.
export function publicView(data, now) {
  const eras = data.eras.map(e => ({ ...e, status: eraStatus(e, now) }));
  const status = slug => eras.find(e => e.slug === slug)?.status ?? 'upcoming';
  const products = data.products
    .filter(p => status(p.era) !== 'upcoming')
    .map(p => ({
      ...p,
      soldOut: p.soldOut === true,
      soldOutVariants: p.soldOutVariants ?? [],
      buyable: status(p.era) === 'live' && p.soldOut !== true,
    }));
  return { eras, products };
}

export function eraSummary(era, products) {
  const { slug, name, tagline, hero, status, dropsAt, endsAt } = era;
  const productCount = status === 'upcoming' ? 0 : products.filter(p => p.era === slug).length;
  return { slug, name, tagline, hero, status, dropsAt, endsAt, productCount };
}

export function eraDetail(era) {
  const { slug, name, tagline, hero, status, dropsAt, endsAt, story } = era;
  const base = { slug, name, tagline, hero, status, dropsAt, endsAt };
  return status === 'upcoming' ? base : { ...base, story };
}

export function imagesFor(product, colorName) {
  const c = product.colors.find(x => x.name === colorName);
  return c?.images ?? product.images ?? product.colors[0]?.images;
}

export const money = cents => '$' + (cents / 100).toFixed(2);

export const findProduct = (products, id) => products.find(p => p.id === id);
