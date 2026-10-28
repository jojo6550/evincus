import { HttpError } from './http.js';
import { isOpId, readOp, opPut } from './ops.js';

// Stock is one document per product, `stock:<productId>` → { '<colour>|<size>': { onHand, committed } }, so a
// checkout or stock save checks one key per product, within @deno/kv's 10 checks per commit. No metadata: a
// document can outgrow its 1 KiB.
export const stockKey = productId => 'stock:' + productId;

// Value for a commit put, from the document as an object or a Map.
export const stockDoc = doc => JSON.stringify(doc instanceof Map ? Object.fromEntries(doc) : doc);

// One stock movement. `opId` and `i` make a retried write land on the same key.
export const adjKey = (productId, iso, opId, i) => `adj:${productId}:${iso}:${opId}:${i}`;

// Commits each order line against its product's stock document, as read into `entries` (productId → getEntry
// result). Pure: one check and one put per product, plus an unguarded adj: put per line.
export function checkoutStock(entries, lines, products, { orderId, now }) {
  const docs = new Map([...entries].map(([id, e]) => [id, JSON.parse(e.value ?? '{}')]));
  const at = now.toISOString();
  const short = [];
  const adjs = lines.map((l, i) => {
    const doc = docs.get(l.id);
    const variant = `${l.color}|${l.size}`;
    const { onHand = 0, committed = 0 } = doc[variant] ?? {};
    // Clamped: an earlier continueSelling oversell is never shown to shoppers.
    if (products.find(p => p.id === l.id)?.continueSelling !== true && l.qty > onHand - committed) short.push({ key: l.key, available: Math.max(0, onHand - committed) });
    doc[variant] = { ...doc[variant], onHand, committed: committed + l.qty };
    return { key: adjKey(l.id, at, orderId, i), value: JSON.stringify({ key: l.key, onHand: 0, committed: l.qty, reason: 'order', note: '', by: null, at, orderId }) };
  });
  if (short.length) return { short };
  return {
    checks: [...entries].map(([id, e]) => ({ key: stockKey(id), version: e.version })),
    puts: [...[...docs].map(([id, doc]) => ({ key: stockKey(id), value: stockDoc(doc) })), ...adjs],
  };
}

export const REASONS = ['received', 'correction', 'damaged', 'returned', 'other'];

const bad = () => new HttpError('invalid-stock', 400);

// Adds or removes units from one product's On hand. Deltas never touch Committed; removing may not dip below it.
// `products` is the current catalog, for key validation. A stored op: result is returned as-is (the first one wins).
export async function adjustStock(env, { opId, productId, changes, reason, note = '', by, now, products }) {
  const product = products.find(p => p.id === productId);
  if (!product) throw new HttpError('unknown-product', 404);
  const known = new Set(product.colors.flatMap(c => product.sizes.map(s => `${productId}|${c.name}|${s}`)));
  if (!isOpId(opId) || !REASONS.includes(reason) || typeof note !== 'string' || note.length > 200
    || !Array.isArray(changes) || !changes.length || changes.length > 200
    || !changes.every(ch => known.has(ch?.key) && Number.isInteger(ch.delta) && ch.delta !== 0)) throw bad();
  const at = now.toISOString();
  const key = stockKey(productId);
  for (let round = 0; round < 5; round++) {
    const done = await readOp(env, opId);
    if (done) return done;
    const { value, version } = await env.ORDERS.getEntry(key);
    const doc = JSON.parse(value ?? '{}');
    const stock = {};
    for (const { key: k, delta } of changes) {
      const variant = k.slice(productId.length + 1);
      const { onHand = 0, committed = 0 } = doc[variant] ?? {};
      if (delta < 0 && (onHand + delta < 0 || onHand + delta < committed)) throw new HttpError('stock-below-committed', 409, { key: k });
      doc[variant] = { ...doc[variant], onHand: onHand + delta, committed };
      stock[k] = { onHand: onHand + delta, committed };
    }
    const result = { stock };
    const ok = await env.ORDERS.commit({
      checks: [{ key, version }],
      puts: [
        { key, value: stockDoc(doc) },
        ...changes.map((ch, i) => ({ key: adjKey(productId, at, opId, i), value: JSON.stringify({ key: ch.key, onHand: ch.delta, committed: 0, reason, note, by, at }) })),
        opPut(opId, result),
      ],
    });
    if (ok) return result;
  }
  throw new HttpError('stock-busy', 409);
}

// Pages through every key under a prefix.
export async function listAll(kv, prefix) {
  const keys = [];
  let cursor;
  for (;;) {
    const page = await kv.list({ prefix, cursor });
    keys.push(...page.keys);
    if (page.list_complete) return keys;
    cursor = page.cursor;
  }
}

export async function loadStock(env) {
  const names = (await listAll(env.ORDERS, 'stock:')).map(k => k.name);
  const docs = await Promise.all(names.map(name => env.ORDERS.get(name, 'json')));
  const out = new Map();
  names.forEach((name, i) => {
    for (const [variant, s] of Object.entries(docs[i] ?? {})) out.set(`${name.slice('stock:'.length)}|${variant}`, { onHand: s.onHand ?? 0, committed: s.committed ?? 0 });
  });
  return out;
}
