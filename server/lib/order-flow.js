// Pure order rules: no I/O, no clock. Callers persist record + movements atomically.
import { HttpError } from './http.js';

export const FULFILMENT = ['UNFULFILLED', 'READY', 'FULFILLED', 'CANCELLED'];

export const fulfilmentOf = r => r.fulfilmentStatus || 'UNFULFILLED';
const typeOf = r => r.fulfillment?.type || 'pickup';
const refundedQty = (r, key) => r.refundedQty?.[key] || 0;
const remaining = (r, l) => l.qty - refundedQty(r, l.key);
const invalid = () => new HttpError('invalid-action', 400);
const posInt = n => Number.isInteger(n) && n > 0;

function taxShare(r, itemsCents) {
  return r.subtotalCents > 0 ? Math.round((r.taxCents || 0) * itemsCents / r.subtotalCents) : 0;
}

// Merge duplicate keys, check each is a real line with qty left.
function pickLines(r, lines) {
  if (!Array.isArray(lines) || !lines.length) throw invalid();
  const want = new Map();
  for (const l of lines) {
    if (!l || typeof l.key !== 'string' || !posInt(l.qty)) throw invalid();
    want.set(l.key, (want.get(l.key) || 0) + l.qty);
  }
  return [...want].map(([key, qty]) => {
    const line = r.lines.find(x => x.key === key);
    if (!line || qty > remaining(r, line)) throw invalid();
    return { line, qty };
  });
}

const itemsOf = picked => picked.reduce((s, p) => s + p.line.unitCents * p.qty, 0);

export function defaultRefundCents(record, lines) {
  const items = itemsOf(pickLines(record, lines));
  return items + taxShare(record, items);
}

export function applyAction(record, action, { by = null, now } = {}) {
  const rec = structuredClone(record);
  const state = fulfilmentOf(rec);
  const event = { at: now.toISOString(), type: action?.type, by: by ?? null };
  const stock = rec.stockCommitted === true;
  let movements = [];
  const move = (line, onHand, committed, reason) => {
    if (stock && (onHand || committed)) movements.push({ key: line.key, onHand, committed, reason });
  };

  switch (action?.type) {
    case 'ready':
      if (typeOf(rec) !== 'pickup' || state !== 'UNFULFILLED') throw invalid();
      rec.fulfilmentStatus = 'READY';
      break;
    case 'fulfilled':
      if (state !== 'UNFULFILLED' && !(state === 'READY' && typeOf(rec) === 'pickup')) throw invalid();
      for (const l of rec.lines) { const q = remaining(rec, l); if (q > 0) move(l, -q, -q, 'sold'); }
      rec.fulfilmentStatus = 'FULFILLED';
      break;
    case 'cancel': {
      if ((state !== 'UNFULFILLED' && state !== 'READY') || typeof action.restock !== 'boolean') throw invalid();
      for (const l of rec.lines) { const q = remaining(rec, l); if (q > 0) move(l, action.restock ? 0 : -q, -q, 'cancelled'); }
      rec.fulfilmentStatus = 'CANCELLED';
      event.restock = action.restock;
      break;
    }
    case 'refund': {
      const { lines, amountCents, restock, reason } = action;
      if (!['PAID', 'PARTIALLY_REFUNDED'].includes(rec.paymentStatus) || typeof restock !== 'boolean'
        || !posInt(amountCents) || typeof reason !== 'string' || !reason.trim() || reason.length > 500) throw invalid();
      const picked = pickLines(rec, lines);
      const doneCents = rec.refundedCents || 0;
      if (doneCents + amountCents > rec.totalCents) throw invalid();
      const tax = Math.min(taxShare(rec, itemsOf(picked)), (rec.taxCents || 0) - (rec.refundedTaxCents || 0));
      for (const { line, qty } of picked) {
        rec.refundedQty = { ...rec.refundedQty, [line.key]: refundedQty(rec, line.key) + qty };
        if (state === 'FULFILLED') { if (restock) move(line, qty, 0, 'refunded'); }
        else if (state !== 'CANCELLED') move(line, restock ? 0 : -qty, -qty, 'refunded');
      }
      rec.refundedCents = doneCents + amountCents;
      rec.refundedTaxCents = (rec.refundedTaxCents || 0) + tax;
      const all = rec.lines.every(l => remaining(rec, l) === 0);
      rec.paymentStatus = all || rec.refundedCents >= rec.totalCents ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
      Object.assign(event, { restock, lines: picked.map(p => ({ key: p.line.key, qty: p.qty })), amountCents, taxCents: tax, reason: reason.trim() });
      break;
    }
    case 'note': {
      const text = typeof action.text === 'string' ? action.text.trim() : '';
      if (!text || text.length > 500) throw invalid();
      event.text = text;
      break;
    }
    default:
      throw invalid();
  }
  rec.events = [...(rec.events || []), event];
  return { record: rec, movements };
}

export function orderSummary(r) {
  const loc = r.fulfillment?.location;
  return {
    totalCents: r.totalCents,
    payment: r.paymentStatus,
    fulfilment: fulfilmentOf(r),
    type: typeOf(r),
    locationId: loc?.id ?? loc ?? null,
    units: r.lines.reduce((s, l) => s + remaining(r, l), 0),
    placedAt: r.placedAt,
  };
}
