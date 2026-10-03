import { findProduct, imagesFor } from '../../data/products.js';

const KEY = 'evincus_bag';
const listeners = new Set();

function read() {
  try { return JSON.parse(localStorage.getItem(KEY)) || []; }
  catch { return []; }
}

let items = read();

function save() {
  try { localStorage.setItem(KEY, JSON.stringify(items)); } catch { /* storage blocked — bag lives for this tab only */ }
  listeners.forEach(fn => fn(items));
}

const lineId = (id, color, size) => `${id}|${color}|${size}`;

// Resolve stored lines against the catalog so prices can't drift from localStorage edits.
export function lines() {
  return items
    .map(i => {
      const p = findProduct(i.id);
      if (!p || !p.sizes.includes(i.size) || !p.colors.some(c => c.name === i.color)) return null;
      if (!Number.isInteger(i.qty) || i.qty < 1 || i.key !== lineId(i.id, i.color, i.size)) return null;
      return { ...i, name: p.name, price: p.price, image: imagesFor(p, i.color)[0], total: p.price * i.qty };
    })
    .filter(Boolean);
}

export function count()    { return lines().reduce((n, l) => n + l.qty, 0); }
export function subtotal() { return lines().reduce((n, l) => n + l.total, 0); }

export function add(id, color, size, qty = 1) {
  const key = lineId(id, color, size);
  const hit = items.find(i => i.key === key);
  if (hit) hit.qty = Math.min(hit.qty + qty, 10);
  else items.push({ key, id, color, size, qty });
  save();
}

export function setQty(key, qty) {
  const hit = items.find(i => i.key === key);
  if (!hit) return;
  if (qty < 1) items = items.filter(i => i.key !== key);
  else hit.qty = Math.min(qty, 10);
  save();
}

export function remove(key) { items = items.filter(i => i.key !== key); save(); }
export function clear()     { items = []; save(); }
export function onChange(fn) { listeners.add(fn); }
