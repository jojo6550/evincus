import { PICKUP_LOCATIONS, deliveryCountries } from '../../data/fulfillment.js';
import { HttpError } from './http.js';
import { shippingCents } from './pricing.js';

const field = (value, max, required = true) => {
  if (value === undefined && !required) return '';
  if (typeof value !== 'string' || value.trim().length > max || (required && !value.trim()) || /[\x00-\x1f]/.test(value)) {
    throw new HttpError('invalid-checkout', 400);
  }
  return value.trim();
};

export function parseCheckout(body, env) {
  const customer = {
    name: field(body?.customer?.name, 100),
    email: field(body?.customer?.email, 254).toLowerCase(),
    phone: field(body?.customer?.phone, 40),
  };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customer.email) || !/^[+\d() .-]{7,40}$/.test(customer.phone) || customer.phone.replace(/\D/g, '').length < 7) throw new HttpError('invalid-checkout', 400);
  const f = body?.fulfillment;
  let fulfillment;
  if (f?.type === 'pickup') {
    const location = PICKUP_LOCATIONS.find(l => l.id === f.locationId);
    if (!location) throw new HttpError('invalid-checkout', 400);
    fulfillment = { type: 'pickup', location: { ...location } };
  } else if (f?.type === 'delivery') {
    const a = f.address;
    const country = field(a?.country_code, 2).toUpperCase();
    if (!deliveryCountries(env).includes(country)) throw new HttpError('unsupported-country', 400);
    fulfillment = { type: 'delivery', address: {
      address_line_1: field(a?.address_line_1, 150), address_line_2: field(a?.address_line_2, 150, false),
      admin_area_2: field(a?.admin_area_2, 100), admin_area_1: field(a?.admin_area_1, 100, false),
      postal_code: field(a?.postal_code, 20, false), country_code: country,
    } };
    if (['US', 'CA'].includes(country) && (!fulfillment.address.admin_area_1 || !fulfillment.address.postal_code)) throw new HttpError('invalid-checkout', 400);
  } else throw new HttpError('invalid-checkout', 400);
  return { customer, fulfillment, notes: field(body?.notes, 1000, false) };
}

export const checkoutShipping = (env, type) => type === 'pickup' ? 0 : shippingCents(env);

export function directRecord(id, q, details, now) {
  return {
    id, status: 'PLACED', paymentStatus: 'NOT_COLLECTED', placedAt: now.toISOString(),
    lines: q.lines.map(({ key, id, name, color, size, qty, unitCents }) => ({ key, id, name, color, size, qty, unitCents })),
    subtotalCents: q.subtotalCents, shippingCents: q.shippingCents, totalCents: q.totalCents,
    ...details,
    payer: { ...details.customer, firstName: details.customer.name.split(' ')[0] },
    shipTo: { name: details.customer.name, address: details.fulfillment.address ?? {} },
    email: { customer: 'pending', owner: 'daily-summary', attempts: 0 },
  };
}
