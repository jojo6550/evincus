import { json, fail, readJson } from '../lib/http.js';
import { SALES_KEY } from '../lib/sales.js';
import { isSale } from '../../data/catalog.js';

const MAX_SALES = 50;
const noStore = { 'Cache-Control': 'no-store' };

// Compares HMACs under a key made for this check, so the comparison's timing says nothing about the token.
async function sameToken(given, token) {
  const key = await crypto.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sign = s => crypto.subtle.sign('HMAC', key, new TextEncoder().encode(s));
  const [a, b] = (await Promise.all([sign(given), sign(token)])).map(x => new Uint8Array(x));
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// Not found until ADMIN_TOKEN is set; then the request must carry it as a Bearer token.
async function denied(req, c) {
  if (!c.env.ADMIN_TOKEN) return fail(c, 'not-found', 404);
  const header = req.headers.get('Authorization') ?? '';
  const given = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!given || !(await sameToken(given, c.env.ADMIN_TOKEN))) return fail(c, 'unauthorized', 401);
  return null;
}

// GET /api/admin/sales → { sales, version }. Used by npm run discount.
export async function getSalesRoute(req, c) {
  const refused = await denied(req, c);
  if (refused) return refused;
  const { value, version } = await c.env.ORDERS.getEntry(SALES_KEY);
  return json({ sales: value ? JSON.parse(value) : [], version }, 200, noStore);
}

// PUT /api/admin/sales { sales, version }: saves the list only if nothing changed it since `version` was read.
export async function putSalesRoute(req, c) {
  const refused = await denied(req, c);
  if (refused) return refused;
  const body = await readJson(req, 65536);
  const { sales, version } = body ?? {};
  const valid = Array.isArray(sales) && sales.length <= MAX_SALES && sales.every(s => isSale(s)) &&
    (version === null || typeof version === 'string');
  if (!valid) return fail(c, 'invalid-sales', 400);
  const saved = await c.env.ORDERS.commit({ checks: [{ key: SALES_KEY, version }], puts: [{ key: SALES_KEY, value: JSON.stringify(sales) }] });
  if (!saved) return fail(c, 'sales-changed', 409);
  c.log.info('sales.updated', { count: sales.length });
  // Return the stored entry's own list and version, so a write that lands after ours can't be paired with our list.
  const cur = await c.env.ORDERS.getEntry(SALES_KEY);
  return json({ sales: JSON.parse(cur.value), version: cur.version }, 200, noStore);
}
