import { PICKUP_LOCATIONS } from '../../data/fulfillment.js';
import { HttpError } from './http.js';

const field = (value, max, required = true) => {
  if (value === undefined && !required) return '';
  if (typeof value !== 'string' || value.trim().length > max || (required && !value.trim()) || /[\x00-\x1f]/.test(value)) {
    throw new HttpError('invalid-checkout', 400);
  }
  return value.trim();
};

export function parseCheckout(body) {
  const customer = {
    name: field(body?.customer?.name, 100),
    email: field(body?.customer?.email, 254).toLowerCase(),
    phone: field(body?.customer?.phone, 40),
  };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customer.email) || !/^[+\d() .-]{7,40}$/.test(customer.phone) || customer.phone.replace(/\D/g, '').length < 7) throw new HttpError('invalid-checkout', 400);
  const f = body?.fulfillment;
  const location = f?.type === 'pickup' && PICKUP_LOCATIONS.find(l => l.id === f.locationId);
  if (!location) throw new HttpError('invalid-checkout', 400);
  return { customer, fulfillment: { type: 'pickup', location: { ...location } }, notes: field(body?.notes, 1000, false) };
}

export function directRecord(id, q, details, now) {
  return {
    id, status: 'PLACED', paymentStatus: 'NOT_COLLECTED', placedAt: now.toISOString(),
    lines: q.lines.map(({ key, id, name, color, size, qty, unitCents }) => ({ key, id, name, color, size, qty, unitCents })),
    subtotalCents: q.subtotalCents, totalCents: q.totalCents,
    ...details,
    payer: { ...details.customer, firstName: details.customer.name.split(' ')[0] },
    email: { customer: 'pending', owner: 'daily-summary', attempts: 0 },
  };
}
