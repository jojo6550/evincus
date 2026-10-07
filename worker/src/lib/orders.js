import { money } from '../../../data/catalog.js';

export const ORDER_TTL = 63072000; // 2 years
export const orderKey = id => `order:${id}`;

export const findOrder = (env, id) => env.ORDERS.get(orderKey(id), 'json');

export async function saveOrder(env, record) {
  await env.ORDERS.put(orderKey(record.id), JSON.stringify(record), { expirationTtl: ORDER_TTL });
  const day = record.placedAt ? new Date(Date.parse(record.placedAt) - 5 * 3600000).toISOString().slice(0, 10) : record.capturedAt.slice(0, 10);
  await env.ORDERS.put(`day:${day}:${record.id}`, '', { expirationTtl: ORDER_TTL });
}

export const updateOrder = (env, record) =>
  env.ORDERS.put(orderKey(record.id), JSON.stringify(record), { expirationTtl: ORDER_TTL });

// PayPal's capture time, so concurrent or repeated finishes of one order build the same record (same day key, same
// email bodies under the same Resend idempotency keys). Falls back to now when PayPal omits or garbles it.
function captureTime(capture, now) {
  const t = Date.parse(capture?.create_time ?? '');
  return Number.isNaN(t) ? now.toISOString() : new Date(t).toISOString();
}

export function buildRecord(captured, q, now) {
  const unit = captured.purchase_units?.[0] ?? {};
  const payerName = captured.payer?.name ?? {};
  const capture = unit.payments?.captures?.[0];
  return {
    id: captured.id,
    captureId: capture?.id ?? null,
    captureStatus: capture?.status ?? 'UNKNOWN',
    capturedAt: captureTime(capture, now),
    status: 'COMPLETED',
    lines: q.lines.map(({ key, name, color, size, qty, unitCents }) => ({ key, name, color, size, qty, unitCents })),
    subtotalCents: q.subtotalCents,
    shippingCents: q.shippingCents,
    totalCents: q.totalCents,
    payer: {
      name: [payerName.given_name, payerName.surname].filter(Boolean).join(' '),
      firstName: payerName.given_name ?? '',
      email: captured.payer?.email_address ?? '',
    },
    shipTo: { name: unit.shipping?.name?.full_name ?? '', address: unit.shipping?.address ?? {} },
    email: { customer: 'pending', owner: 'pending', attempts: 0 },
  };
}

export const addressLines = a =>
  [a.address_line_1, a.address_line_2, a.admin_area_2, a.admin_area_1, a.postal_code, a.country_code].filter(Boolean);

// Label/value rows for owner emails and alerts.
export function recordRows(r) {
  const pending = r.captureStatus && r.captureStatus !== 'COMPLETED';
  return [
    ...(r.placedAt ? [['Status', 'Placed — no payment collected'], ['Placed at', r.placedAt], ['Phone', r.customer.phone], ['Fulfillment', r.fulfillment.type === 'pickup' ? `Pickup: ${r.fulfillment.location.name}, ${r.fulfillment.location.address ?? r.fulfillment.location.area + ' (address to be confirmed)'}` : 'Delivery'], ['Notes', r.notes]] : []),
    ...(pending ? [['Payment status', `${r.captureStatus} — don't ship until PayPal shows it completed`]] : []),
    ['Order', r.id],
    ...(!r.placedAt ? [['Capture', r.captureId ?? ''], ['Captured at', r.capturedAt]] : []),
    ['Payer', `${r.payer.name} <${r.payer.email}>`],
    ...(r.fulfillment?.type !== 'pickup' ? [['Ship to', [r.shipTo.name, ...addressLines(r.shipTo.address)].join(', ')]] : []),
    ...r.lines.map(l => [`${l.qty} × ${l.name}`, `${l.color} / ${l.size} at ${money(l.unitCents)}`]),
    ['Subtotal', money(r.subtotalCents)],
    ['Shipping', money(r.shippingCents)],
    ['Total', `${money(r.totalCents)} USD`],
  ];
}
