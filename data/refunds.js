// Refund money math, shared by the server (server/lib/order-flow.js enforces it) and the Orders tab (shows its
// default), so the amount the tab offers is the one the server allows. Pure: null where the server refuses.
export const refundedQty = (r, key) => r.refundedQty?.[key] || 0;
export const remaining = (r, l) => l.qty - refundedQty(r, l.key);
const posInt = n => Number.isInteger(n) && n > 0;

function taxShare(r, itemsCents) {
  return r.subtotalCents > 0 ? Math.round((r.taxCents || 0) * itemsCents / r.subtotalCents) : 0;
}

// Merge duplicate keys, check each is a real line with qty left. -> [{ line, qty }], or null.
export function pickLines(r, lines) {
  if (!Array.isArray(lines) || !lines.length) return null;
  const want = new Map();
  for (const l of lines) {
    if (!l || typeof l.key !== 'string' || !posInt(l.qty)) return null;
    want.set(l.key, (want.get(l.key) || 0) + l.qty);
  }
  const picked = [];
  for (const [key, qty] of want) {
    const line = r.lines.find(x => x.key === key);
    if (!line || qty > remaining(r, line)) return null;
    picked.push({ line, qty });
  }
  return picked;
}

const itemsOf = picked => picked.reduce((s, p) => s + p.line.unitCents * p.qty, 0);

// Largest refund for these lines. A pick that completes the order gets the exact tax left, so per-line rounding can't
// strand a cent; any other pick takes at most the tax left, so rounding up can't use it up early. Never above the room left.
export function plan(r, picked) {
  const items = itemsOf(picked);
  const share = taxShare(r, items);
  const taxLeft = (r.taxCents || 0) - (r.refundedTaxCents || 0);
  const lastOf = picked.every(p => p.qty === remaining(r, p.line)) && r.lines.every(l => picked.some(p => p.line === l) || remaining(r, l) === 0);
  const room = r.totalCents - (r.feeCents || 0) - (r.refundedCents || 0); // the processing fee is never refunded
  const full = items + Math.min(share, taxLeft);
  return { share, taxLeft, lastOf, full, cap: Math.min(lastOf ? items + taxLeft : full, room) };
}

// The default (and largest) refund for `lines` [{ key, qty }], or null when they can't be refunded.
export function defaultRefundCents(record, lines) {
  const picked = pickLines(record, lines);
  return picked && plan(record, picked).cap;
}
