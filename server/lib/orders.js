import { money } from '../../data/catalog.js';

export const ORDER_TTL = 63072000; // 2 years
export const orderKey = id => `order:${id}`;
export const retryKey = id => `email-retry:${id}`;

export const findOrder = (env, id) => env.ORDERS.get(orderKey(id), 'json');

// The Jamaica day an order was placed (UTC-5, no DST).
export function dayKey(record) {
  const day = new Date(Date.parse(record.placedAt) - 5 * 3600000).toISOString().slice(0, 10);
  return `day:${day}:${record.id}`;
}

export const updateOrder = (env, record) =>
  env.ORDERS.put(orderKey(record.id), JSON.stringify(record), { expirationTtl: ORDER_TTL });

// Label/value rows for the owner's daily summary.
export function recordRows(r) {
  return [
    ['Status', 'Placed — no payment collected'], ['Placed at', r.placedAt], ['Phone', r.customer.phone], ['Pickup', r.fulfillment.location ? `${r.fulfillment.location.name}, ${r.fulfillment.location.address ?? r.fulfillment.location.area + ' (address to be confirmed)'}` : ''], ['Notes', r.notes],
    ['Order', r.id],
    ['Payer', `${r.payer.name} <${r.payer.email}>`],
    ...r.lines.map(l => [`${l.qty} × ${l.name}`, `${l.color} / ${l.size} at ${money(l.unitCents)}`]),
    ['Subtotal', money(r.subtotalCents)],
    ['Total', `${money(r.totalCents)} USD`],
  ];
}
