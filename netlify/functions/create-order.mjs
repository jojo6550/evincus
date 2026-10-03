import { randomBytes } from 'node:crypto';
import { CartError, priceCart } from './lib/pricing.mjs';
import { createOrder } from './lib/paypal.mjs';
import { json, readJson } from './lib/http.mjs';

// POST /api/orders  { items: [{ id, color, size, qty }] }  ->  { id }
export default async req => {
  if (req.method !== 'POST') return json({ error: 'method-not-allowed' }, 405);

  const body = await readJson(req);
  let priced;
  try {
    priced = priceCart(body?.items);
  } catch (err) {
    if (err instanceof CartError) return json({ error: err.message }, 400);
    throw err;
  }

  try {
    const order = await createOrder(priced, randomBytes(12).toString('hex'));
    return json({ id: order.id });
  } catch (err) {
    console.error('create-order failed', err);
    return json({ error: 'paypal-error' }, 502);
  }
};

export const config = { path: '/api/orders' };
