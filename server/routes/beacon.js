import { fail, readJson } from '../lib/http.js';

export const BEACON_EVENTS = new Set(['quote-failed', 'api-unreachable']);
const OPTIONAL = ['code', 'route', 'reqId'];
const ALLOWED = new Set(['event', ...OPTIONAL]);

// Checkout-only error reports from the browser. Fixed schema, small, rate limited per IP.
export async function beacon(req, c) {
  const { success } = await c.env.BEACON_LIMIT.limit({ key: c.ip });
  if (!success) return fail(c, 'rate-limited', 429);

  const body = await readJson(req, 2048);
  const valid = body && typeof body === 'object' && !Array.isArray(body) &&
    BEACON_EVENTS.has(body.event) &&
    Object.keys(body).every(k => ALLOWED.has(k)) &&
    OPTIONAL.every(k => body[k] === undefined || (typeof body[k] === 'string' && body[k].length <= 200));
  if (!valid) return fail(c, 'invalid-beacon', 400);

  // Never log arbitrary caller-supplied text or a hash containing customer data.
  const safeCode = /^[a-z0-9-]{1,80}$/.test(body.code ?? '') ? body.code : undefined;
  const safeRoute = /^#\/(?:checkout|bag|shop)?$/.test(body.route ?? '') ? body.route : '#/';
  const safeId = /^[a-z0-9-]{1,80}$/i.test(body.reqId ?? '') ? body.reqId : undefined;
  c.log.warn('client.error', { clientEvent: body.event, code: safeCode, clientRoute: safeRoute, clientReqId: safeId });
  return new Response(null, { status: 204 });
}
