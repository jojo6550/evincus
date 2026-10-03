import { findProduct } from '../../../data/products.js';

const MAX_LINES = 50;
const MAX_QTY = 10;

export class CartError extends Error {}

export const toCents = n => Math.round(Number(n) * 100);
export const fromCents = c => (c / 100).toFixed(2);

export function shippingCents(env = process.env) {
  const n = Number(env.SHIPPING_USD ?? 0);
  return Number.isFinite(n) && n >= 0 ? toCents(n) : 0;
}

// Prices a cart of {id, color, size, qty} from the server-side catalog. Client prices are never read.
export function priceCart(items, shipping = shippingCents()) {
  if (!Array.isArray(items) || !items.length || items.length > MAX_LINES) throw new CartError('invalid-cart');

  const seen = new Set();
  const lines = items.map(i => {
    const p = findProduct(i?.id);
    const key = `${i?.id}|${i?.color}|${i?.size}`;
    if (!p || !p.sizes.includes(i.size) || !p.colors.some(c => c.name === i.color)) throw new CartError('unknown-item');
    if (!Number.isInteger(i.qty) || i.qty < 1 || i.qty > MAX_QTY) throw new CartError('invalid-qty');
    if (seen.has(key)) throw new CartError('duplicate-line');
    seen.add(key);
    return { key, name: p.name, color: i.color, size: i.size, qty: i.qty, unitCents: toCents(p.price) };
  });

  const subtotal = lines.reduce((n, l) => n + l.unitCents * l.qty, 0);
  return { lines, subtotal, shipping, total: subtotal + shipping };
}
