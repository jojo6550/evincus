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

// Rebuilds the cart from a PayPal purchase unit's line items and re-prices it from the catalog.
// Returns true only if the unit's total, shipping and every line's unit price match the catalog.
export function unitMatchesCatalog(unit, shipping = shippingCents()) {
  try {
    const items = unit?.items?.map(it => {
      const [id, color, size, ...extra] = String(it.sku).split('|');
      if (extra.length || !/^[1-9]\d*$/.test(it.quantity)) throw new CartError('invalid-line');
      return { id, color, size, qty: Number(it.quantity), sku: it.sku, unit_amount: it.unit_amount };
    });
    const priced = priceCart(items, shipping);
    const money = c => ({ currency_code: 'USD', value: fromCents(c) });
    const same = (a, b) => a?.currency_code === b.currency_code && a?.value === b.value;
    return (
      same(unit.amount, money(priced.total)) &&
      same(unit.amount.breakdown?.item_total, money(priced.subtotal)) &&
      same(unit.amount.breakdown?.shipping, money(priced.shipping)) &&
      priced.lines.every((l, i) => items[i].sku === l.key && same(items[i].unit_amount, money(l.unitCents)))
    );
  } catch (err) {
    if (err instanceof CartError) return false;
    throw err;
  }
}
