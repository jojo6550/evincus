import { HttpError, json, fail, readJson } from '../lib/http.js';
import { accountKey, verifyLogin, startSession, sessionCookie, clearCookie, staffFrom, requireStaff, isHttps } from '../lib/accounts.js';
import { adjustStock } from '../lib/stock.js';

const noStore = { 'Cache-Control': 'no-store' };

// A limiter outage fails closed as 503 (not 429, which would read as abuse), like enforceLimit.
async function allowed(c, limiter, key) {
  if (!limiter) return true;
  try { return (await limiter.limit({ key })).success; } catch {
    c.log.error('login.limiter_error');
    throw new HttpError('server-error', 503);
  }
}

// Records the sign-in time; a lost race or outage must not fail the login.
async function touch(env, key, now) {
  try {
    const { value, version } = await env.ORDERS.getEntry(key);
    if (value) await env.ORDERS.commit({ checks: [{ key, version }], puts: [{ key, value: JSON.stringify({ ...JSON.parse(value), lastLoginAt: now.toISOString() }) }] });
  } catch { /* best effort */ }
}

// POST /api/inventory/login { email, password } → { email, role } + session cookie.
export async function loginRoute(req, c) {
  const body = (await readJson(req, 2048)) ?? {};
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase().slice(0, 255) : '';
  const password = typeof body.password === 'string' ? body.password : '';
  const key = accountKey(email);
  const known = !!(await c.env.ORDERS.get(key)); // the typed address is logged only when it has an account
  const who = known ? email : null;
  // Limits first: every attempt past them would cost a 600k-round PBKDF2.
  if (!(await allowed(c, c.env.LOGIN_IP_LIMIT, c.ip)) || !(await allowed(c, c.env.LOGIN_EMAIL_LIMIT, email))) {
    c.log.warn('login.blocked', { account: who });
    return fail(c, 'rate-limited', 429);
  }
  const found = await verifyLogin(c.env, email, password);
  if (!found) {
    c.log.warn('login.failed', { account: who });
    return fail(c, 'login-failed', 401);
  }
  const token = await startSession(c.env, found, c.now);
  await touch(c.env, key, c.now);
  c.log.info('login.ok', { account: who });
  return json({ email: found.email, role: found.role }, 200, { ...noStore, 'Set-Cookie': sessionCookie(token, isHttps(req)) });
}

// POST /api/inventory/logout: always 204 with the cookie cleared, signed in or not.
export async function logoutRoute(req, c) {
  try {
    const staff = await staffFrom(req, c.env, c.now);
    if (staff) await c.env.ORDERS.delete(staff.sessionKey);
  } catch (err) { c.log.error('logout.failed', { message: String(err?.message ?? err) }); } // the cookie is cleared regardless
  return new Response(null, { status: 204, headers: { 'Set-Cookie': clearCookie(isHttps(req)) } });
}

// POST /api/inventory/stock { opId, productId, changes: [{ key, delta }], reason, note } → { stock }.
export async function adjustStockRoute(req, c) {
  const { email } = await requireStaff(req, c, { role: 'owner', write: true });
  const b = (await readJson(req, 65536)) ?? {};
  const result = await adjustStock(c.env, { ...b, by: email, now: c.now, products: c.data.products });
  c.log.info('stock.adjusted', { account: email, changes: b.changes.length });
  return json(result, 200, noStore);
}

// GET /api/inventory/me → { email, role, local }.
export async function meRoute(req, c) {
  const staff = await requireStaff(req, c);
  return json({ ...staff, local: c.env.ENVIRONMENT === 'development' }, 200, noStore);
}
