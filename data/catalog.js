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

// Attaches on-hand minus committed per variant; a variant with no stock record has none.
export function applyStock(data, stock) {
  const products = data.products.map(p => ({
    ...p,
    available: Object.fromEntries(p.colors.flatMap(c => p.sizes.map(size => {
      const k = lineKey(p.id, c.name, size);
      const { onHand = 0, committed = 0 } = stock.get(k) ?? {};
      return [`${c.name}|${size}`, onHand - committed];
    }))),
  }));
  return { ...data, products };
}

const isSoldOut = (p, color, size) => (p.available?.[`${color}|${size}`] ?? 0) <= 0 && p.continueSelling !== true;

const eraOf = (data, slug) => data.eras.find(e => e.slug === slug);

export const isVisible = (p, data) =>
  (p.status ?? 'active') === 'active' && !!eraOf(data, p.era) && (eraOf(data, p.era).state ?? 'published') === 'published';

// Status of one bag line. Checks run in this order so nothing leaks about unreleased products.
export function lineStatus(data, now, { id, color, size }) {
  const p = data.products.find(x => x.id === id);
  if (!p || !isVisible(p, data)) return 'unknown-item';
  const era = statusOf(data, p.era, now);
  if (era === 'upcoming') return 'not-released';
  if (!p.sizes.includes(size) || !p.colors.some(c => c.name === color)) return 'unknown-item';
  if (era === 'archived') return 'era-ended';
  if (isSoldOut(p, color, size)) return 'sold-out';
  return 'ok';
}

// What a shopper may see at `now`: every era with its status, and products of released eras.
export function publicView(data, now) {
  const eras = data.eras.filter(e => (e.state ?? 'published') === 'published').map(e => ({ ...e, status: eraStatus(e, now) }));
  const status = slug => eras.find(e => e.slug === slug)?.status ?? 'upcoming';
  const products = data.products
    .filter(p => isVisible(p, data) && status(p.era) !== 'upcoming')
    .map(({ available, costCents, skus, ...p }) => {
      const soldOutVariants = p.colors.flatMap(c => p.sizes.map(s => [c.name, s])).map(([c, s]) => `${c}|${s}`)
        .filter(k => isSoldOut({ ...p, available }, ...k.split('|')));
      const soldOut = soldOutVariants.length === p.colors.length * p.sizes.length;
      return { ...p, soldOut, soldOutVariants, buyable: status(p.era) === 'live' && !soldOut };
    });
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

// ---------- sales ----------
// A sale takes `percent` off every product in `eras` (null = every era) from startsAt until endsAt.
// Sales are written by `npm run discount` and applied at request time, so start and end are exact to the second.
export const SALE_MAX_PERCENT = 90;

const isSlugList = v => v === null || (Array.isArray(v) && v.length > 0 && v.every(s => typeof s === 'string' && s));

export const isSale = s =>
  !!s && typeof s === 'object' && typeof s.id === 'string' &&
  Number.isInteger(s.percent) && s.percent >= 1 && s.percent <= SALE_MAX_PERCENT &&
  isSlugList(s.eras) && Number.isFinite(time(s.startsAt)) && Number.isFinite(time(s.endsAt)) && time(s.startsAt) < time(s.endsAt);

// Valid sales that haven't ended. Upcoming ones are kept so caches can expire when they start.
export const pendingSales = (sales, now) => (Array.isArray(sales) ? sales : []).filter(s => isSale(s) && +now < time(s.endsAt));

export const activeSales = (sales, now) => pendingSales(sales, now).filter(s => time(s.startsAt) <= +now);

export const salePrice = (cents, percent) => Math.round(cents * (100 - percent) / 100);

// The deepest active sale on an era; ties go to the one that runs longest.
export function bestSale(sales, slug, now) {
  return activeSales(sales, now)
    .filter(s => s.eras === null || s.eras.includes(slug))
    .sort((a, b) => b.percent - a.percent || time(b.endsAt) - time(a.endsAt))[0] ?? null;
}

// Re-prices products under active sales and their own salePriceCents, whichever is lower. priceCents becomes the
// sale price; compareAtCents keeps the original.
export function applySales(data, sales, now) {
  const pending = pendingSales(sales, now);
  const products = data.products.map(({ salePriceCents: own, ...p }) => {
    const s = bestSale(pending, p.era, now);
    const era = s ? salePrice(p.priceCents, s.percent) : Infinity;
    const fixed = Number.isSafeInteger(own) && own > 0 && own < p.priceCents ? own : Infinity;
    if (era === Infinity && fixed === Infinity) return p;
    if (fixed < era) return { ...p, priceCents: fixed, compareAtCents: p.priceCents };
    return { ...p, priceCents: era, compareAtCents: p.priceCents, sale: { id: s.id, percent: s.percent, endsAt: s.endsAt } };
  });
  return { ...data, products, sales: pending };
}

// What shoppers see about running sales.
export const publicSales = (sales, now) =>
  activeSales(sales, now).map(({ id, percent, eras, label, startsAt, endsAt }) => ({ id, percent, eras, label: label ?? null, startsAt, endsAt }));
