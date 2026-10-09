import { MAX_QTY, lineKey, lineStatus, imagesFor } from '../../data/catalog.js';

export const MAX_LINES = 50;
export const COUNTED = new Set(['ok', 'qty-capped']);

export class CartError extends Error {}

export const fromCents = c => (c / 100).toFixed(2);

export function shippingCents(env) {
  const n = Number(env.SHIPPING_USD ?? 0);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : 0;
}

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
export function quote(data, now, items, shipping) {
  const lines = parseItems(items).map(i => {
    let status = lineStatus(data, now, i);
    if (status === 'ok' && i.qty > MAX_QTY) status = 'qty-capped';
    const qty = Math.min(i.qty, MAX_QTY);
    const base = { key: i.key, id: i.id, color: i.color, size: i.size, qty, status };
    if (status === 'not-released' || status === 'unknown-item') return base;
    const p = data.products.find(x => x.id === i.id);
    return { ...base, name: p.name, image: imagesFor(p, i.color)?.[0] ?? null, unitCents: p.priceCents, totalCents: p.priceCents * qty };
  });
  const counted = lines.filter(l => COUNTED.has(l.status));
  const subtotalCents = counted.reduce((n, l) => n + l.totalCents, 0);
  const ship = counted.length ? shipping : 0;
  return {
    lines,
    subtotalCents,
    shippingCents: ship,
    totalCents: subtotalCents + ship,
    checkoutReady: lines.length > 0 && lines.every(l => COUNTED.has(l.status)),
  };
}

export const statusCounts = lines => lines.reduce((acc, l) => ({ ...acc, [l.status]: (acc[l.status] ?? 0) + 1 }), {});

// Rebuilds bag items from a PayPal purchase unit's SKUs. Null if any line is malformed.
export function itemsFromUnit(unit) {
  if (!Array.isArray(unit?.items) || !unit.items.length) return null;
  const items = [];
  for (const it of unit.items) {
    const parts = String(it?.sku ?? '').split('|');
    if (parts.length !== 3 || !/^[1-9]\d*$/.test(String(it.quantity))) return null;
    items.push({ id: parts[0], color: parts[1], size: parts[2], qty: Number(it.quantity) });
  }
  return items;
}

const toCents = v => Math.round(Number(v) * 100);

// What PayPal actually charged, as a quote-shaped object: amounts from the purchase unit, names from `q` when it priced the same SKU.
export function chargedQuote(unit, q) {
  const priced = new Map((q?.lines ?? []).map(l => [l.key, l]));
  const items = itemsFromUnit(unit) ?? [];
  const lines = items.map((i, n) => {
    const it = unit.items[n];
    return { key: it.sku, name: priced.get(it.sku)?.name ?? String(it.name ?? i.id), color: i.color, size: i.size, qty: i.qty, unitCents: toCents(it.unit_amount?.value) };
  });
  const totalCents = toCents(unit.amount?.value);
  const shipping = unit.amount?.breakdown?.shipping?.value;
  const itemTotal = unit.amount?.breakdown?.item_total?.value;
  const shippingCents = shipping === undefined ? 0 : toCents(shipping);
  return { lines, subtotalCents: itemTotal === undefined ? totalCents - shippingCents : toCents(itemTotal), shippingCents, totalCents };
}

// True only if every line is plainly buyable and every amount PayPal holds equals the quote.
export function unitMatchesQuote(unit, q) {
  const money = c => ({ currency_code: 'USD', value: fromCents(c) });
  const same = (a, b) => a?.currency_code === b.currency_code && a?.value === b.value;
  return (
    q.lines.every(l => l.status === 'ok') &&
    unit.items.length === q.lines.length &&
    same(unit.amount, money(q.totalCents)) &&
    same(unit.amount?.breakdown?.item_total, money(q.subtotalCents)) &&
    same(unit.amount?.breakdown?.shipping, money(q.shippingCents)) &&
    q.lines.every((l, i) => unit.items[i].sku === l.key && same(unit.items[i].unit_amount, money(l.unitCents)))
  );
}
