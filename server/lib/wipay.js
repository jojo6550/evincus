// WiPay hosted checkout (Jamaica platform): request a payment page and verify the redirect back.
import { createHash, timingSafeEqual } from 'node:crypto';
import { HttpError } from './http.js';

const BASES = { live: 'https://jm.wipayfinancial.com', sandbox: 'https://jmsb.wipayfinancial.com' };

// null when payments are switched off (no account or key yet).
export function wipayConfig(env) {
  if (!env.WIPAY_ACCOUNT_NUMBER || !env.WIPAY_API_KEY) return null;
  const environment = env.WIPAY_ENVIRONMENT === 'live' ? 'live' : 'sandbox';
  return { base: BASES[environment], environment, accountNumber: Number(env.WIPAY_ACCOUNT_NUMBER), apiKey: env.WIPAY_API_KEY };
}

export const formatTotal = cents => `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
// 248 is the largest multiple of 62 under 256, so rejecting bytes above it keeps every character equally likely.
export function newAttemptId() {
  let id = '';
  while (id.length < 16) for (const b of crypto.getRandomValues(new Uint8Array(32))) if (b < 248 && id.length < 16) id += ALPHABET[b % 62];
  return id;
}

// [SB-]<1-99>-<WiPay user id>-<order_id>-<YYYYMMDDhhmmss>; the attempt ID is [A-Za-z0-9], so it needs no escaping.
export function validTransactionId(id, attemptId, environment) {
  const prefix = environment === 'sandbox' ? 'SB-' : '';
  return typeof id === 'string' && new RegExp(`^${prefix}\\d{1,2}-[^-]+-${attemptId}-\\d{14}$`).test(id);
}

// WiPay's hash covers the total we sent, not the one in the redirect.
export function verifyHash({ transactionId, totalCents, apiKey, hash }) {
  if (typeof hash !== 'string') return false;
  const want = Buffer.from(createHash('md5').update(transactionId + formatTotal(totalCents) + apiKey).digest('hex'));
  const got = Buffer.from(hash);
  return got.length === want.length && timingSafeEqual(got, want);
}

const e164 = phone => {
  const p = String(phone ?? '').replace(/[\s().-]/g, '');
  return /^\+[1-9]\d{7,14}$/.test(p) ? p : null;
};

// -> { url, transactionId }. The address is not sent: WiPay's `state` wants ISO 3166-2 codes and ours is free-form.
export async function requestPayment(config, { attemptId, totalCents, customer, address, responseUrl, version }) {
  const phone = e164(customer.phone);
  const body = {
    account_number: config.accountNumber, country_code: 'JM', currency: 'USD', environment: config.environment,
    fee_structure: 'merchant_absorb', method: 'credit_card_co', order_id: attemptId, origin: 'evincus',
    response_url: responseUrl, total: formatTotal(totalCents), email: customer.email, fname: customer.firstName,
    lname: customer.lastName, ...(phone && { phone }), country: address?.country ?? 'JM', version,
  };
  let res, data;
  try {
    res = await fetch(`${config.base}/plugins/payments/request`, {
      method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    data = await res.json();
  } catch { throw new HttpError('payment-unavailable', 502); }
  if (res.status !== 200 || typeof data?.url !== 'string' || !data.url.startsWith('https://')) throw new HttpError('payment-unavailable', 502);
  return { url: data.url, transactionId: data.transaction_id };
}
