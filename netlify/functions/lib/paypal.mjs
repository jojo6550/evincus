import { createHmac, timingSafeEqual } from 'node:crypto';
import { fromCents } from './pricing.mjs';

export const CURRENCY = 'USD';

const apiBase = () =>
  process.env.PAYPAL_ENV === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';

function credentials() {
  const id = process.env.PAYPAL_CLIENT_ID;
  const secret = process.env.PAYPAL_CLIENT_SECRET;
  if (!id || !secret) throw new Error('PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET not set');
  return { id, secret };
}

async function accessToken() {
  const { id, secret } = credentials();
  const res = await fetch(`${apiBase()}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error(`PayPal auth failed (${res.status})`);
  return (await res.json()).access_token;
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(apiBase() + path, {
    method,
    headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`PayPal ${method} ${path} failed (${res.status}): ${data.name ?? ''}`);
  return data;
}

// Orders carry a tag only this server can produce. Without it an attacker could create their own
// cheap order with the public client ID and ask us to capture it.
const sign = (nonce, value) =>
  createHmac('sha256', credentials().secret).update(`${nonce}|${CURRENCY}|${value}`).digest('hex');

export function verifyTag(customId, value) {
  const [nonce, sig] = String(customId ?? '').split('.');
  if (!nonce || !sig) return false;
  const want = Buffer.from(sign(nonce, value));
  const got = Buffer.from(sig);
  return want.length === got.length && timingSafeEqual(want, got);
}

export function createOrder({ lines, subtotal, shipping, total }, nonce) {
  const value = fromCents(total);
  const money = c => ({ currency_code: CURRENCY, value: fromCents(c) });
  return api('/v2/checkout/orders', {
    method: 'POST',
    body: {
      intent: 'CAPTURE',
      purchase_units: [{
        description: 'Evincus order',
        custom_id: `${nonce}.${sign(nonce, value)}`,
        amount: {
          currency_code: CURRENCY,
          value,
          breakdown: { item_total: money(subtotal), shipping: money(shipping) },
        },
        items: lines.map(l => ({
          name: l.name.slice(0, 127),
          description: `${l.color} / ${l.size}`.slice(0, 127),
          sku: l.key.slice(0, 127),
          quantity: String(l.qty),
          unit_amount: money(l.unitCents),
          category: 'PHYSICAL_GOODS',
        })),
      }],
    },
  });
}

export const getOrder = id => api(`/v2/checkout/orders/${encodeURIComponent(id)}`);
export const captureOrder = id =>
  api(`/v2/checkout/orders/${encodeURIComponent(id)}/capture`, { method: 'POST', body: {} });
