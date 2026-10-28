import { HttpError, json, fail, readJson } from '../lib/http.js';
import { accountKey, verifyLogin, startSession, sessionCookie, clearCookie, staffFrom, requireStaff, isHttps } from '../lib/accounts.js';
import { adjustStock, stockKey, listAll } from '../lib/stock.js';
import { productKey, loadCatalog, saveProduct, saveEra, setEraOrder, readEraOrder, productHistory } from '../lib/catalog-store.js';
import { lineKey, imagesFor } from '../../data/catalog.js';
import { photoPath, manifestEntry } from '../../data/photos.js';

const noStore = { 'Cache-Control': 'no-store' };

// A JSON object body, or 400 `code`.
async function objectBody(req, max, code) {
  const b = await readJson(req, max);
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw new HttpError(code, 400);
  return b;
}
// Display variants for each photo ref, keyed by its media path.
const mediaOf = refs => Object.fromEntries(refs.filter(Boolean).map(r => [photoPath(r), manifestEntry(r)]));
// Cost edits are history records too, so viewers get neither.
const shown = (history, owner) => (owner ? history : { ...history, items: history.items.filter(i => i.field !== 'costCents') });

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
  const b = await objectBody(req, 65536, 'invalid-stock');
  const { result, replayed } = await adjustStock(c.env, { ...b, by: email, now: c.now, products: c.data.products });
  c.log.info(replayed ? 'stock.adjust_replayed' : 'stock.adjusted', { account: email, changes: b.changes?.length ?? 0 });
  return json(result, 200, noStore);
}

// GET /api/inventory/products → { products, totals }, every status. Stock at cost is owners only.
export async function listProductsRoute(req, c) {
  const owner = (await requireStaff(req, c)).role === 'owner';
  const totals = { onHand: 0, committed: 0, ...(owner && { stockCents: 0 }) };
  const products = c.data.products.map(p => {
    const rows = p.colors.flatMap(col => p.sizes.map(s => c.stock.get(lineKey(p.id, col.name, s)) ?? { onHand: 0, committed: 0 }));
    const onHand = rows.reduce((n, r) => n + r.onHand, 0), committed = rows.reduce((n, r) => n + r.committed, 0);
    const free = rows.map(r => r.onHand - r.committed);
    totals.onHand += onHand;
    totals.committed += committed;
    const row = {
      id: p.id, name: p.name, era: p.era, status: p.status ?? 'active', cover: imagesFor(p, p.colors[0]?.name)?.[0] ?? null,
      skus: Object.values(p.skus ?? {}), variants: rows.length, available: onHand - committed, onHand, committed,
      low: free.some(n => n <= (p.lowStockAt ?? 3)), out: free.filter(n => n <= 0).length,
    };
    if (owner) totals.stockCents += row.stockCents = onHand * (p.costCents ?? 0);
    return row;
  });
  return json({ products, totals }, 200, noStore);
}

// GET /api/inventory/products/:id → { product, version, stock, history, media }: the stored document the page edits.
export async function getProductRoute(req, c) {
  const owner = (await requireStaff(req, c)).role === 'owner';
  const id = c.params[0];
  const [entry, stock, history] = await Promise.all([c.env.ORDERS.getEntry(productKey(id)), c.env.ORDERS.get(stockKey(id), 'json'), productHistory(c.env, id)]);
  if (!entry.value) throw new HttpError('unknown-product', 404);
  const product = JSON.parse(entry.value);
  if (!owner) delete product.costCents;
  const refs = [...(product.images ?? []), ...product.colors.flatMap(col => col.images ?? [])];
  return json({ product, version: entry.version, stock: stock ?? {}, history: shown(history, owner), media: mediaOf(refs) }, 200, noStore);
}

// GET /api/inventory/products/:id/history?before=<next> → { items, next }, the next page, newest first.
export async function productHistoryRoute(req, c) {
  const owner = (await requireStaff(req, c)).role === 'owner';
  const before = new URL(req.url).searchParams.get('before') ?? undefined;
  return json(shown(await productHistory(c.env, c.params[0], { before }), owner), 200, noStore);
}

// PUT /api/inventory/products/:id { opId, product, version, renames? } → { product, version }. version null creates.
export async function saveProductRoute(req, c) {
  const { email } = await requireStaff(req, c, { role: 'owner', write: true });
  const b = await objectBody(req, 262144, 'invalid-product');
  const { product, version, created, replayed } = await saveProduct(c.env, { opId: b.opId, id: c.params[0], product: b.product, renames: b.renames, version: b.version, by: email, now: c.now });
  c.log.info('product.saved', { account: email, product: product.id, created, replayed });
  return json({ product, version }, 200, noStore);
}

// GET /api/inventory/eras → { eras: [{ era, version, productCount }], order, version, media }, in the store's order.
export async function listErasRoute(req, c) {
  await requireStaff(req, c);
  const [{ order, version }, catalog, keys] = await Promise.all([readEraOrder(c.env), loadCatalog(c.env), listAll(c.env.ORDERS, 'era:')]);
  const rank = slug => (order.includes(slug) ? order.indexOf(slug) : order.length);
  const eras = (await Promise.all(keys.map(k => c.env.ORDERS.getEntry(k.name)))).filter(e => e.value)
    .map(e => ({ era: JSON.parse(e.value), version: e.version })).sort((a, b) => rank(a.era.slug) - rank(b.era.slug))
    .map(e => ({ ...e, productCount: catalog.products.filter(p => p.era === e.era.slug).length }));
  return json({ eras, order, version, media: mediaOf(eras.map(e => e.era.hero)) }, 200, noStore);
}

// PUT /api/inventory/eras/:slug { opId, era, version } → { era, version }. version null creates.
export async function saveEraRoute(req, c) {
  const { email } = await requireStaff(req, c, { role: 'owner', write: true });
  const b = await objectBody(req, 32768, 'invalid-era');
  const { era, version, created, replayed } = await saveEra(c.env, { opId: b.opId, slug: c.params[0], era: b.era, version: b.version, by: email, now: c.now });
  c.log.info('era.saved', { account: email, era: era.slug, created, replayed });
  return json({ era, version }, 200, noStore);
}

// PUT /api/inventory/era-order { opId, order, version } → { order, version }.
export async function eraOrderRoute(req, c) {
  const { email } = await requireStaff(req, c, { role: 'owner', write: true });
  const b = await objectBody(req, 16384, 'invalid-era-order');
  const { order, version, replayed } = await setEraOrder(c.env, { opId: b.opId, order: b.order, version: b.version });
  c.log.info('era.order_saved', { account: email, replayed });
  return json({ order, version }, 200, noStore);
}

// GET /api/inventory/me → { email, role, local }.
export async function meRoute(req, c) {
  const staff = await requireStaff(req, c);
  return json({ ...staff, local: c.env.ENVIRONMENT === 'development' }, 200, noStore);
}
