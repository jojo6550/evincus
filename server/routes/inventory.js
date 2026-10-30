import { HttpError, json, fail, readJson } from '../lib/http.js';
import { accountKey, verifyLogin, startSession, sessionCookie, clearCookie, staffFrom, requireStaff, isHttps } from '../lib/accounts.js';
import { adjustStock, stockKey, listAll } from '../lib/stock.js';
import { productKey, loadCatalog } from '../lib/catalog-store.js';
import { saveProduct, saveEra, setEraOrder, readEraOrder, productHistory } from '../lib/catalog-save.js';
import { lineKey, imagesFor } from '../../data/catalog.js';
import { uploadPhoto } from '../lib/media.js';
import { orderAction, orderKey, findOrder, listOrders, jamaicaDay, VIEWS } from '../lib/orders.js';
import { PERSONAL_FIELDS } from '../lib/retention.js';
import { loadStats } from '../lib/stats.js';
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

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const isDay = d => DATE.test(d) && new Date(Date.parse(`${d}T00:00:00Z`) || 0).toISOString().startsWith(d);
const CURSOR = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\|([A-Za-z0-9-]+)$/;
const MAX_DAYS = 366; // each day is one KV walk
const digits = s => String(s ?? '').replace(/\D/g, '');
// "Tanya Marie Brown" → "Tanya B."; no name (scrubbed) → "—".
const shortName = name => {
  const parts = String(name ?? '').trim().split(/\s+/).filter(Boolean);
  return !parts.length ? '—' : parts.length === 1 ? parts[0] : `${parts[0]} ${[...parts.at(-1)][0]}.`;
};

// GET /api/inventory/orders?view=&from=&to=&location=&payment=&product=&q=&cursor= → { orders, cursor }, 50 a page.
// Dates are Jamaica days, by default the last 30. `q` (order id, customer name or phone) is owners only.
export async function listOrdersRoute(req, c) {
  const owner = (await requireStaff(req, c)).role === 'owner';
  const p = new URL(req.url).searchParams;
  const view = p.get('view') || 'open', to = p.get('to') || jamaicaDay(+c.now);
  const from = p.get('from') || (isDay(to) ? new Date(Date.parse(`${to}T00:00:00Z`) - 29 * 86400000).toISOString().slice(0, 10) : '');
  const [location, payment, product, q, rawCursor] = ['location', 'payment', 'product', 'q', 'cursor'].map(k => p.get(k)?.trim() || '');
  const cursor = rawCursor.match(CURSOR);
  const span = (Date.parse(to) - Date.parse(from)) / 86400000;
  // A cursor names a row inside the range: one from elsewhere would walk days the range never covers.
  const cursorDay = cursor && !Number.isNaN(Date.parse(cursor[1])) ? jamaicaDay(Date.parse(cursor[1])) : null;
  if (!Object.hasOwn(VIEWS, view) || !isDay(from) || !isDay(to) || !(span >= 0 && span < MAX_DAYS) || q.length > 100
    || (rawCursor && !(cursorDay >= from && cursorDay <= to))) throw new HttpError('invalid-query', 400);
  if (q && !owner) throw new HttpError('forbidden', 403);
  const needle = q.toLowerCase(), phone = /^ev-/i.test(q) ? '' : digits(q); // an order number is never phone digits
  const found = o => [o.id, o.customer?.name].some(s => s?.toLowerCase().includes(needle)) || (phone.length >= 3 && digits(o.customer?.phone).includes(phone));
  const out = await listOrders(c.env, {
    from, to, cursor: cursor && { placedAt: cursor[1], id: cursor[2] },
    keep: m => VIEWS[view](m) && (!location || m.locationId === location) && (!payment || m.payment === payment),
    match: (product || q) && (o => (!product || o.lines.some(l => l.id === product)) && (!q || found(o))),
  });
  // Owners see who ordered: read only for the rows sent, after the metadata filters.
  if (owner) await Promise.all(out.orders.map(async row => { row.name = shortName((await findOrder(c.env, row.id))?.customer?.name); }));
  return json(out, 200, noStore);
}

// GET /api/inventory/orders/:id → { order, version, covers, scrubbed? }. Viewers get no personal data, internal notes
// or cost. `covers` maps each line key to a catalog photo, or null.
export async function getOrderRoute(req, c) {
  const owner = (await requireStaff(req, c)).role === 'owner';
  const e = await c.env.ORDERS.getEntry(orderKey(c.params[0]));
  if (!e.value) throw new HttpError('unknown-order', 404);
  const order = JSON.parse(e.value);
  if (!owner) {
    for (const f of PERSONAL_FIELDS) delete order[f];
    // Owners may write customer details into notes and refund reasons.
    order.events = (order.events ?? []).filter(ev => ev.type !== 'note').map(({ reason, ...ev }) => ev);
    order.lines = order.lines.map(({ costCents, ...l }) => l);
  }
  const covers = Object.fromEntries(order.lines.map(l => {
    const p = c.data.products.find(x => x.id === l.id);
    return [l.key, (p && imagesFor(p, l.color)?.[0]) ?? null];
  }));
  return json({ order, version: e.version, covers, ...(order.scrubbedAt && { scrubbed: true }) }, 200, noStore);
}

const ACTION_EVENTS = { ready: 'order.ready', fulfilled: 'order.fulfilled', cancel: 'order.cancelled', refund: 'order.refunded', note: 'order.noted' };

// POST /api/inventory/orders/:id/actions { opId, version, action } → { order, version }.
export async function orderActionRoute(req, c) {
  const { email } = await requireStaff(req, c, { role: 'owner', write: true });
  const b = await objectBody(req, 16384, 'invalid-action');
  let out;
  try { out = await orderAction(c.env, c.params[0], b, { by: email, now: c.now }); } catch (err) {
    if (err.code === 'stock-mismatch') c.log.error('order.stock_mismatch', { orderId: c.params[0], account: email, key: err.extra.key });
    throw err;
  }
  const { order, version, replayed } = out;
  c.log.info(ACTION_EVENTS[b.action?.type] ?? 'order.action', { orderId: c.params[0], account: email, replayed });
  return json({ order, version }, 200, noStore);
}

// GET /api/inventory/stats?period=today|7d|30d|custom&from=&to= → tiles, perDay, best, sizes, pickup, low. Viewers and
// owners alike: aggregates only, no customers, cost or profit.
export async function statsRoute(req, c) {
  await requireStaff(req, c);
  const p = new URL(req.url).searchParams;
  const out = await loadStats(c.env, { period: p.get('period') || '30d', from: p.get('from'), to: p.get('to'), now: c.now, catalog: c.data, stock: c.stock, rev: c.data.rev });
  return json(out, 200, noStore);
}

// GET /api/inventory/me → { email, role, local }.
export async function meRoute(req, c) {
  const staff = await requireStaff(req, c);
  return json({ ...staff, local: c.env.ENVIRONMENT === 'development' }, 200, noStore);
}

// PUT /api/inventory/media (multipart, one `file` per variant) → the photo ref. Content-named, so repeating it is a no-op.
export async function uploadMediaRoute(req, c) {
  const { email } = await requireStaff(req, c, { role: 'owner', write: true });
  const ref = await uploadPhoto(req, c.env.MEDIA);
  c.log.info('media.uploaded', { account: email, photo: ref.id });
  return json(ref, 200, noStore);
}
