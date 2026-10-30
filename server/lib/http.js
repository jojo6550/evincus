export class HttpError extends Error {
  constructor(code, status, extra = {}) {
    super(code);
    this.code = code;
    this.status = status;
    this.extra = extra; // merged into the error body, e.g. { key }
  }
}

// Shopper-facing messages. Say what happened and what to do next.
export const MESSAGES = {
  'invalid-checkout': 'Check your name, email, phone and pickup details, then try again.',
  'checkout-conflict': 'This checkout was already submitted with different details. Reopen your cart to start a new checkout.',
  'invalid-photo': "That photo can't be used. Upload a JPEG or WebP photo and try again.",
  'not-found': "There's nothing at this address.",
  'method-not-allowed': "This address doesn't accept that kind of request.",
  'too-large': 'That request is too large to process.',
  'rate-limited': 'Too many requests. Wait a minute, then try again.',
  'server-error': 'Something went wrong on our side. Try again in a minute.',
  'maintenance': 'The store is down for maintenance. Check back soon.',
  'stocking': 'The store is down for restocking. Check back soon.',
  'unknown-era': "There's no collection at this address. It may have been renamed.",
  'unknown-product': "This piece isn't in the store. It may have sold out or been renamed.",
  'invalid-cart': "Your cart couldn't be read. Refresh the page and try again.",
  'too-many-products': 'A cart can hold up to 8 different pieces per checkout. Remove some, then check out.',
  'invalid-order': "That order reference isn't valid. Start checkout again from your cart.",
  'invalid-email': 'Enter a valid email address, like you@email.com.',
  'newsletter-link': 'That link has expired or is incomplete. Sign up again from the bottom of the store page.',
  'invalid-beacon': 'That report was not in the expected format.',
  'bag-changed': 'Some items in your cart changed. Check your cart, then check out again.',
  'busy': 'Lots of people are checking out right now. Your cart is safe — try again in a moment.',
  'unauthorized': 'That admin token is missing or wrong.',
  'invalid-sales': 'That sales list is not valid.',
  'login-failed': "That email and password don't match an account.",
  'account-changed': 'That account changed while saving. Run the command again.',
  'invalid-account': 'That account is not valid.',
  'signed-out': 'Sign in to continue.',
  'forbidden': "Your account can't do that.",
  'bad-origin': 'That request came from another site and was refused.',
  'invalid-stock': "Those stock changes can't be saved. Reload and try again.",
  'stock-below-committed': "You can't remove units that are promised to orders. Cancel or refund the order first.",
  'stock-busy': 'Someone else changed this stock at the same time. Reload and try again.',
  'sales-changed': 'Sales changed since you read them. Read them again, then retry.',
  'invalid-product': "Some details can't be saved. Fix the marked fields, then save again.",
  'product-changed': 'This product changed while saving. Reload and try again.',
  'product-exists': 'A product with that id already exists. Pick another id.',
  'invalid-era': "Some era details can't be saved. Fix the marked fields, then save again.",
  'era-changed': 'Someone else saved this era while you were editing. Check their changes, then save again.',
  'era-exists': 'An era with that slug already exists. Pick another slug.',
  'invalid-era-order': "That era order can't be saved. Reload and try again.",
  'era-order-changed': 'Someone else moved the eras while you were editing. Reload and try again.',
  'catalog-busy': 'Someone else saved at the same time. Try again.',
  'invalid-action': "That can't be done to this order.",
  'unknown-order': "There's no order with that reference.",
  'order-changed': 'This order changed since you opened it. Check it again, then retry.',
  'stock-short': "There isn't enough stock on hand for this. Record the stock you received, then try again.",
  'variant-gone': 'That colour or size no longer exists. Refund it without putting it back in stock.',
  'stock-mismatch': "This order's stock numbers don't add up. Check the stock for this product before trying again.",
  'order-busy': 'Someone else changed this order at the same time. Reload and try again.',
  'invalid-query': 'Those filters can’t be used. Pick dates up to a year apart and try again.',
  'op-reused': 'That request ID was already used for something else. Reload and try again.',
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

// Reads a body of at most maxBytes; throws 413 above that.
export async function readBytes(req, maxBytes) {
  if (Number(req.headers.get('content-length') ?? 0) > maxBytes) {
    if (req.body) void req.body.cancel().catch(() => {});
    throw new HttpError('too-large', 413);
  }
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        void reader.cancel().catch(() => {});
        throw new HttpError('too-large', 413);
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const out = new Uint8Array(bytes);
  let at = 0;
  for (const ch of chunks) { out.set(ch, at); at += ch.byteLength; }
  return out;
}

// Parses a JSON body. Returns undefined for unparseable bodies; throws 413 for oversized ones.
export async function readJson(req, maxBytes = 16384) {
  if (!req.body) return undefined;
  const bytes = await readBytes(req, maxBytes);
  try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { return undefined; }
}

// Limit before parsing or reading prices. A storage outage fails closed.
export async function enforceLimit(c, limiter, namespace = '') {
  if (!limiter) return;
  let result;
  try { result = await limiter.limit({ key: `${namespace}${c.ip}` }); }
  catch { throw new HttpError('server-error', 503); }
  if (!result.success) throw new HttpError('rate-limited', 429);
}

const LOCAL = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

// STATUS (live | maintenance | stocking) closes the store on the public domain. The built-in onrender.com URL is the
// dev link and always shows the store. Unknown values close it, so a typo never opens the store by accident.
export function siteStatus(req, env) {
  const status = env.STATUS || 'live';
  const host = String(req.headers.get('host') ?? '').toLowerCase().split(':')[0];
  return status === 'live' || host.endsWith('.onrender.com') ? 'live' : status === 'stocking' ? 'stocking' : 'maintenance';
}

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
