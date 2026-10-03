import { fromCents } from './pricing.js';

export const CURRENCY = 'USD';

export class PaypalError extends Error {
  constructor(op, status, upstream) {
    super(`PayPal ${op} failed (${status})${upstream ? ` ${upstream}` : ''}`);
    this.op = op;
    this.status = status;
    this.upstream = upstream ?? null;
  }
}

const apiBase = env => (env.PAYPAL_ENV === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com');

async function accessToken(env) {
  if (!env.PAYPAL_CLIENT_ID || !env.PAYPAL_CLIENT_SECRET) throw new Error('PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET not set');
  const res = await fetch(`${apiBase(env)}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + btoa(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new PaypalError('auth', res.status);
  return (await res.json()).access_token;
}

async function api(env, op, path, { method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(apiBase(env) + path, {
    method,
    headers: { Authorization: `Bearer ${await accessToken(env)}`, 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new PaypalError(op, res.status, data.name);
  return data;
}

// Orders carry a tag only this server can produce, so orders made elsewhere with the public client ID can't be captured here.
const enc = new TextEncoder();
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const unhex = s => (/^[0-9a-f]{64}$/.test(s) ? Uint8Array.from(s.match(/../g), h => parseInt(h, 16)) : null);

async function hmacKey(env) {
  if (!env.ORDER_HMAC_KEY) throw new Error('ORDER_HMAC_KEY not set');
  return crypto.subtle.importKey('raw', enc.encode(env.ORDER_HMAC_KEY), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export function newNonce() {
  return hex(crypto.getRandomValues(new Uint8Array(12)));
}

export async function signTag(env, nonce, value) {
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(env), enc.encode(`${nonce}|${CURRENCY}|${value}`));
  return `${nonce}.${hex(sig)}`;
}

export async function verifyTag(env, customId, value) {
  const [nonce, sig, ...rest] = String(customId ?? '').split('.');
  const bytes = unhex(sig ?? '');
  if (!nonce || !bytes || rest.length) return false;
  return crypto.subtle.verify('HMAC', await hmacKey(env), bytes, enc.encode(`${nonce}|${CURRENCY}|${value}`));
}

export async function createOrder(env, q, nonce) {
  const value = fromCents(q.totalCents);
  const money = c => ({ currency_code: CURRENCY, value: fromCents(c) });
  return api(env, 'create', '/v2/checkout/orders', {
    method: 'POST',
    body: {
      intent: 'CAPTURE',
      purchase_units: [{
        description: 'Evincus order',
        custom_id: await signTag(env, nonce, value),
        amount: {
          currency_code: CURRENCY,
          value,
          breakdown: { item_total: money(q.subtotalCents), shipping: money(q.shippingCents) },
        },
        items: q.lines.map(l => ({
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

export const getOrder = (env, id) => api(env, 'get', `/v2/checkout/orders/${encodeURIComponent(id)}`);

// PayPal-Request-Id makes a repeated capture of the same order return the first result instead of charging twice.
export const captureOrder = (env, id) =>
  api(env, 'capture', `/v2/checkout/orders/${encodeURIComponent(id)}/capture`, {
    method: 'POST',
    body: {},
    headers: { 'PayPal-Request-Id': id },
  });
