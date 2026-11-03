import { PICKUP_LOCATIONS } from '../../data/fulfillment.js';
import { COUNTRIES } from '../../data/countries.js';
import { HttpError } from './http.js';
import { HOLD_MS } from './orders.js';
import { seal } from './crypto.js';

const invalid = () => new HttpError('invalid-checkout', 400);
const field = (value, max, required = true) => {
  if (value === undefined && !required) return '';
  if (typeof value !== 'string' || value.trim().length > max || (required && !value.trim()) || /[\x00-\x1f]/.test(value)) throw invalid();
  return value.trim();
};

// Limits follow WiPay's prefill fields (fname/lname 30, email 50).
export function parseCheckout(body) {
  const c = body?.customer;
  const customer = {
    firstName: field(c?.firstName, 30),
    lastName: field(c?.lastName, 30),
    email: field(c?.email, 50).toLowerCase(),
    phone: field(c?.phone, 40, false),
  };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customer.email)) throw invalid();
  if (customer.phone && (!/^[+\d() .-]{7,40}$/.test(customer.phone) || customer.phone.replace(/\D/g, '').length < 7)) throw invalid();
  const notes = field(body?.notes, 1000, false);
  const f = body?.fulfillment;
  if (f?.type === 'pickup') {
    const location = f.address === undefined && PICKUP_LOCATIONS.find(l => l.id === f.locationId);
    if (!location) throw invalid();
    return { customer, fulfillment: { type: 'pickup', location: { ...location } }, address: null, notes };
  }
  const a = f?.address;
  if (f?.type !== 'shipping' || !a || typeof a !== 'object') throw invalid();
  const address = {
    line1: field(a.line1, 100), line2: field(a.line2, 100, false), city: field(a.city, 60),
    region: field(a.region, 60, false), postalCode: field(a.postalCode, 20, false), country: field(a.country, 2),
  };
  if (!Object.hasOwn(COUNTRIES, address.country)) throw invalid();
  return { customer, fulfillment: { type: 'shipping' }, address, notes };
}

// A new order, unpaid and holding its stock. Customer, address and notes are sealed; the record keeps no plaintext copy.
// `products` are the internal ones, so sku and cost never come from the client.
export async function buildOrder(env, id, q, { customer, fulfillment, address, notes }, now, products) {
  const at = now.toISOString();
  return {
    id, status: 'AWAITING_PAYMENT', paymentStatus: 'UNPAID', placedAt: at, stockCommitted: true,
    holdUntil: new Date(+now + HOLD_MS).toISOString(),
    fulfilmentStatus: 'UNFULFILLED', events: [{ at, type: 'placed', by: null }],
    lines: q.lines.map(({ key, id, name, color, size, qty, unitCents }) => {
      const p = products.find(x => x.id === id);
      return { key, id, name, color, size, qty, unitCents, sku: p.skus?.[`${color}|${size}`] ?? null, costCents: p.costCents ?? null };
    }),
    subtotalCents: q.subtotalCents, taxCents: q.taxCents, feeCents: q.feeCents, taxBps: q.tax.bps, feeBps: q.fee.bps, totalCents: q.totalCents,
    fulfillment,
    pii: await seal(env, { customer, address, notes }),
    email: { customer: 'pending', owner: 'daily-summary', attempts: 0 },
  };
}
