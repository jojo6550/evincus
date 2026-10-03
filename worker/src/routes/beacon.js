import { fail, readJson } from '../lib/http.js';

export const BEACON_EVENTS = new Set(['paypal-sdk-failed', 'quote-failed', 'order-create-failed', 'capture-failed', 'api-unreachable']);
const OPTIONAL = ['code', 'route', 'reqId'];
const ALLOWED = new Set(['event', ...OPTIONAL]);

// Checkout-only error reports from the browser. Fixed schema, small, rate limited per IP.
export async function beacon(req, c) {
  const ip = req.headers.get('CF-Connecting-IP') ?? 'unknown';
  const { success } = await c.env.BEACON_LIMIT.limit({ key: ip });
  if (!success) return fail(c, 'rate-limited', 429);

  const body = await readJson(req, 2048);
  const valid = body && typeof body === 'object' && !Array.isArray(body) &&
    BEACON_EVENTS.has(body.event) &&
    Object.keys(body).every(k => ALLOWED.has(k)) &&
    OPTIONAL.every(k => body[k] === undefined || (typeof body[k] === 'string' && body[k].length <= 200));
  if (!valid) return fail(c, 'invalid-beacon', 400);

  c.log.warn('client.error', { clientEvent: body.event, code: body.code, clientRoute: body.route, clientReqId: body.reqId });
  return new Response(null, { status: 204 });
}
