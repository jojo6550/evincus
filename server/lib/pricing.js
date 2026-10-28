import { MAX_QTY, lineKey, lineStatus, imagesFor } from '../../data/catalog.js';

export const MAX_LINES = 50;
export const MAX_PRODUCTS = 8; // a checkout checks one stock document per product, plus its submission: 9 of @deno/kv's 10
export const COUNTED = new Set(['ok', 'qty-capped']);

export class CartError extends Error {}

const isName = s => typeof s === 'string' && s.length > 0 && s.length <= 100 && !s.includes('|');

// Shape checks only. Catalog problems become line statuses, not errors.
export function parseItems(items) {
  if (!Array.isArray(items) || !items.length || items.length > MAX_LINES) throw new CartError('invalid-cart');
  const seen = new Set();
  return items.map(i => {
    if (!i || typeof i !== 'object') throw new CartError('invalid-cart');
    const { id, color, size, qty } = i;
    if (![id, color, size].every(isName) || !Number.isInteger(qty) || qty < 1) throw new CartError('invalid-cart');
    const key = lineKey(id, color, size);
    if (seen.has(key)) throw new CartError('invalid-cart');
    seen.add(key);
    return { id, color, size, qty, key };
  });
}

// Prices a bag from the catalog. Client prices are never read.
export function quote(data, now, items) {
  const lines = parseItems(items).map(i => {
    let status = lineStatus(data, now, i);
    if (status === 'ok' && i.qty > MAX_QTY) status = 'qty-capped';
    const qty = Math.min(i.qty, MAX_QTY);
    const base = { key: i.key, id: i.id, color: i.color, size: i.size, qty, status };
    if (status === 'not-released' || status === 'unknown-item') return base;
    const p = data.products.find(x => x.id === i.id);
    const available = p.available?.[`${i.color}|${i.size}`] ?? 0;
    if (COUNTED.has(status) && p.continueSelling !== true && qty > available) {
      return { ...base, status: 'insufficient-stock', available, name: p.name, image: imagesFor(p, i.color)?.[0] ?? null, unitCents: p.priceCents, totalCents: p.priceCents * qty };
    }
    return { ...base, name: p.name, image: imagesFor(p, i.color)?.[0] ?? null, unitCents: p.priceCents, totalCents: p.priceCents * qty };
  });
  const counted = lines.filter(l => COUNTED.has(l.status));
  const subtotalCents = counted.reduce((n, l) => n + l.totalCents, 0);
  const tooMany = new Set(lines.map(l => l.id)).size > MAX_PRODUCTS;
  return {
    lines,
    subtotalCents,
    totalCents: subtotalCents,
    checkoutReady: !tooMany && lines.length > 0 && lines.every(l => COUNTED.has(l.status)),
    ...(tooMany && { problem: 'too-many-products' }),
  };
}

export const statusCounts = lines => lines.reduce((acc, l) => ({ ...acc, [l.status]: (acc[l.status] ?? 0) + 1 }), {});
