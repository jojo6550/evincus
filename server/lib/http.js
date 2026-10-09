export class HttpError extends Error {
  constructor(code, status) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

// Shopper-facing messages. Say what happened and what to do next.
export const MESSAGES = {
  'invalid-checkout': 'Check your name, email, phone and delivery or pickup details, then try again.',
  'unsupported-country': 'Delivery is not available to that country. Choose another destination or in-store pickup.',
  'checkout-conflict': 'This checkout was already submitted with different details. Reopen your bag to start a new checkout.',
  'payments-disabled': 'Payments are currently disabled. Place your order from your bag.',
  'not-found': "There's nothing at this address.",
  'method-not-allowed': "This address doesn't accept that kind of request.",
  'too-large': 'That request is too large to process.',
  'rate-limited': 'Too many requests. Wait a minute, then try again.',
  'server-error': 'Something went wrong on our side. Try again in a minute.',
  'unknown-era': "There's no collection at this address. It may have been renamed.",
  'unknown-product': "This piece isn't in the store. It may have sold out or been renamed.",
  'invalid-cart': "Your bag couldn't be read. Refresh the page and try again.",
  'invalid-order': "That order reference isn't valid. Start checkout again from your bag.",
  'invalid-email': 'Enter a valid email address, like you@email.com.',
  'newsletter-link': 'That link has expired or is incomplete. Sign up again from the bottom of the store page.',
  'invalid-beacon': 'That report was not in the expected format.',
  'bag-changed': 'Some items in your bag changed. Check your bag, then check out again.',
  'capture-refused': "This payment couldn't be verified, so you were not charged. Start checkout again from your bag.",
  'capture-mismatch': "Your payment needs a manual check. Don't pay again: we'll contact you by email within one business day.",
  'capture-unknown': "We couldn't confirm your payment. Don't pay again — check your PayPal account or email for a receipt, or DM @evincus.sw on Instagram with your order reference.",
  'payment-declined': 'Your payment method was declined and you were not charged. Try another card or PayPal account.',
  'paypal-error': "PayPal didn't respond and you were not charged. Try again in a minute.",
  'unauthorized': 'That admin token is missing or wrong.',
  'invalid-sales': 'That sales list is not valid.',
  'sales-changed': 'Sales changed since you read them. Read them again, then retry.',
};

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  });
}

export function fail(c, code, status, extra = {}) {
  const message = MESSAGES[code] ?? MESSAGES['server-error'];
  return json({ error: { code, message, requestId: c.reqId, ...extra } }, status, { 'Cache-Control': 'no-store' });
}

// Parses a JSON body. Returns undefined for unparseable bodies; throws 413 for oversized ones.
export async function readJson(req, maxBytes = 16384) {
  if (Number(req.headers.get('content-length') ?? 0) > maxBytes) throw new HttpError('too-large', 413);
  const text = await req.text();
  if (new TextEncoder().encode(text).length > maxBytes) throw new HttpError('too-large', 413);
  try { return JSON.parse(text); } catch { return undefined; }
}

const LOCAL = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

export function corsHeaders(origin, env) {
  if (!origin) return {};
  const allowed = String(env.ALLOWED_ORIGINS ?? '').split(',').map(s => s.trim()).filter(Boolean);
  const local = env.ENVIRONMENT !== 'production' && LOCAL.test(origin);
  if (!allowed.includes(origin) && !local) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Expose-Headers': 'x-request-id',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}
