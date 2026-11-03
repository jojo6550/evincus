// Pure order rules: no I/O, no clock. Callers persist record + movements atomically.
import { HttpError } from './http.js';
import { pickLines as pick, plan, remaining, refundedQty } from '../../data/refunds.js';

export const FULFILMENT = ['UNFULFILLED', 'READY', 'FULFILLED', 'CANCELLED'];

export const fulfilmentOf = r => r.fulfilmentStatus || 'UNFULFILLED';
const typeOf = r => r.fulfillment?.type || 'pickup';
const invalid = () => new HttpError('invalid-action', 400);
const posInt = n => Number.isInteger(n) && n > 0;

function pickLines(r, lines) {
  const picked = pick(r, lines);
  if (!picked) throw invalid();
  return picked;
}

export function defaultRefundCents(record, lines) {
  return plan(record, pickLines(record, lines)).cap;
}

export function applyAction(record, action, { by = null, now } = {}) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw invalid();
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
      // Paid after its hold expired and not re-held: fulfilling would move no stock. Restock, or refund it.
      if (rec.holdLost && rec.stockCommitted !== true) throw new HttpError('stock-short', 409);
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
        || !posInt(amountCents) || typeof reason !== 'string' || !reason.trim() || reason.trim().length > 500) throw invalid();
      const picked = pickLines(rec, lines);
      const doneCents = rec.refundedCents || 0;
      const refundable = rec.totalCents - (rec.feeCents || 0);
      const { cap, taxLeft, lastOf, share, full } = plan(rec, picked);
      // cap already holds the room left; the cumulative check is a backstop should plan() ever change.
      if (amountCents > cap || doneCents + amountCents > refundable) throw invalid();
      const scaled = full > 0 ? Math.round(share * amountCents / full) : 0;
      const tax = Math.max(0, Math.min(lastOf ? taxLeft : scaled, taxLeft, amountCents));
      for (const { line, qty } of picked) {
        rec.refundedQty = { ...rec.refundedQty, [line.key]: refundedQty(rec, line.key) + qty };
        if (state === 'FULFILLED') { if (restock) move(line, qty, 0, 'refunded'); }
        else if (state !== 'CANCELLED') move(line, restock ? 0 : -qty, -qty, 'refunded');
      }
      rec.refundedCents = doneCents + amountCents;
      rec.refundedTaxCents = (rec.refundedTaxCents || 0) + tax;
      const all = rec.lines.every(l => remaining(rec, l) === 0);
      rec.paymentStatus = all || rec.refundedCents >= refundable ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
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
    ...(r.refundedCents && { refundedCents: r.refundedCents }), // stats count sales net of refunds
    payment: r.paymentStatus,
    fulfilment: fulfilmentOf(r),
    type: typeOf(r),
    locationId: loc?.id ?? null,
    units: r.lines.reduce((s, l) => s + remaining(r, l), 0),
    placedAt: r.placedAt,
    ...(r.payment?.paidAt && { paidAt: r.payment.paidAt }), // WiPay orders: the list shows their refund window
    ...(r.scrubbedAt && { scrubbed: true }), // lets the retention walk skip scrubbed orders without reading them
    stockCommitted: r.stockCommitted === true,
    ...(r.holdLost && { holdLost: true }), // paid after its hold expired: redriveLate finds it from metadata alone
  };
}
