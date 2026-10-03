import { CURRENCY, captureOrder, getOrder, verifyTag } from './lib/paypal.mjs';
import { json, readJson } from './lib/http.mjs';

const ORDER_ID = /^[A-Za-z0-9]{8,32}$/;

// POST /api/orders/capture  { orderID }  ->  { id, name, email }
// Captures only orders this server created, and only if the amount PayPal holds matches our signed tag.
export default async req => {
  if (req.method !== 'POST') return json({ error: 'method-not-allowed' }, 405);

  const body = await readJson(req);
  const orderID = body?.orderID;
  if (typeof orderID !== 'string' || !ORDER_ID.test(orderID)) return json({ error: 'invalid-order' }, 400);

  try {
    const order = await getOrder(orderID);
    const unit = order.purchase_units?.[0];
    const amount = unit?.amount;
    if (
      order.purchase_units?.length !== 1 ||
      order.status !== 'APPROVED' ||
      amount?.currency_code !== CURRENCY ||
      !verifyTag(unit.custom_id, amount.value)
    ) {
      return json({ error: 'order-rejected' }, 400);
    }

    const done = await captureOrder(orderID);
    const paid = done.purchase_units?.[0]?.payments?.captures?.[0]?.amount;
    if (done.status !== 'COMPLETED' || paid?.value !== amount.value || paid?.currency_code !== CURRENCY) {
      console.error('capture mismatch', orderID, done.status, paid, amount);
      return json({ error: 'capture-mismatch' }, 502);
    }

    return json({
      id: done.id,
      name: done.payer?.name?.given_name ?? '',
      email: done.payer?.email_address ?? '',
    });
  } catch (err) {
    console.error('capture-order failed', err);
    return json({ error: 'paypal-error' }, 502);
  }
};

export const config = { path: '/api/orders/capture' };
