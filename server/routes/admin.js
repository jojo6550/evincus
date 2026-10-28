import { HttpError, json, fail, readJson } from '../lib/http.js';
import { uploadPhoto, MEDIA_NAME } from '../lib/media.js';
import { SALES_KEY } from '../lib/sales.js';
import { isSale } from '../../data/catalog.js';
import { ROLES, ITERATIONS, accountKey } from '../lib/accounts.js';
import { loadCatalog, eraKey, productKey } from '../lib/catalog-store.js';
import { saveEra, saveProduct } from '../lib/catalog-save.js';

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
    (version === null || (typeof version === 'string' && /^[0-9a-f]{20}$/.test(version)));
  if (!valid) return fail(c, 'invalid-sales', 400);
  const saved = await c.env.ORDERS.commit({ checks: [{ key: SALES_KEY, version }], puts: [{ key: SALES_KEY, value: JSON.stringify(sales) }] });
  if (!saved) return fail(c, 'sales-changed', 409);
  c.log.info('sales.updated', { count: sales.length });
  // Return the stored entry's own list and version, so a write that lands after ours can't be paired with our list.
  const cur = await c.env.ORDERS.getEntry(SALES_KEY);
  return json({ sales: JSON.parse(cur.value), version: cur.version }, 200, noStore);
}

const B64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=|[A-Za-z0-9+/]{4})$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// PUT /api/admin/accounts { email, role?, salt, hash, iterations }: creates an account or replaces its password
// (a new epoch signs its sessions out; epochs are ms timestamps so delete + re-add never revives one). The CLI hashes the password, so it never reaches the server.
export async function putAccountRoute(req, c) {
  const refused = await denied(req, c);
  if (refused) return refused;
  const { email, role, salt, hash, iterations } = (await readJson(req, 4096)) ?? {};
  const mail = typeof email === 'string' ? email.trim().toLowerCase() : '';
  const valid = mail.length <= 254 && EMAIL.test(mail) && (role === undefined || ROLES.includes(role)) &&
    typeof salt === 'string' && B64.test(salt) && atob(salt).length >= 16 && typeof hash === 'string' && B64.test(hash) && atob(hash).length === 32 &&
    Number.isInteger(iterations) && iterations >= ITERATIONS && iterations <= 2000000;
  if (!valid) return fail(c, 'invalid-account', 400);
  const key = accountKey(mail);
  const { value, version } = await c.env.ORDERS.getEntry(key);
  const old = value ? JSON.parse(value) : null;
  const next = old
    ? { ...old, email: mail, role: role ?? old.role, salt, hash, iterations, epoch: Math.max(old.epoch + 1, +c.now) }
    : { email: mail, role: role ?? 'viewer', salt, hash, iterations, epoch: +c.now, createdAt: c.now.toISOString() };
  if (!(await c.env.ORDERS.commit({ checks: [{ key, version }], puts: [{ key, value: JSON.stringify(next) }] }))) return fail(c, 'account-changed', 409);
  c.log.info('account.added', { account: mail, created: !old });
  return json({ email: mail, role: next.role, created: !old }, 200, noStore);
}

// GET /api/admin/accounts → { accounts }, never the hash or salt.
export async function listAccountsRoute(req, c) {
  const refused = await denied(req, c);
  if (refused) return refused;
  const accounts = [];
  let cursor;
  do {
    const page = await c.env.ORDERS.list({ prefix: 'account:', cursor });
    for (const { name } of page.keys) {
      const a = await c.env.ORDERS.get(name, 'json');
      if (a) accounts.push({ email: a.email, role: a.role, createdAt: a.createdAt ?? null, lastLoginAt: a.lastLoginAt ?? null });
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return json({ accounts }, 200, noStore);
}

// GET /api/admin/eras → { eras: [{ slug, name, state }] }, in the store's order. Used by the CLI.
export async function listErasAdminRoute(req, c) {
  const refused = await denied(req, c);
  if (refused) return refused;
  const { eras } = await loadCatalog(c.env);
  return json({ eras: eras.map(({ slug, name, state }) => ({ slug, name, state: state ?? 'published' })) }, 200, noStore);
}

// POST /api/admin/eras { slug, name } → 201 { era, version }: a draft era, first in the order. 409 era-exists.
export async function newEraRoute(req, c) {
  const refused = await denied(req, c);
  if (refused) return refused;
  const { slug, name } = (await readJson(req, 4096)) ?? {};
  const draft = { slug, name, tagline: '', story: '', hero: null, dropsAt: null, endsAt: null, state: 'draft' };
  const { era, version } = await saveEra(c.env, { opId: crypto.randomUUID(), era: draft, version: null, by: null, now: c.now });
  c.log.info('era.saved', { era: era.slug, created: true });
  return json({ era, version }, 201, noStore);
}

// DELETE /api/admin/accounts/<urlencoded email>: its sessions stop working at once, since staffFrom needs the account.
export async function deleteAccountRoute(req, c) {
  const refused = await denied(req, c);
  if (refused) return refused;
  let mail;
  try { mail = decodeURIComponent(c.params[0]).trim().toLowerCase(); } catch { return fail(c, 'not-found', 404); }
  const key = accountKey(mail);
  if (!(await c.env.ORDERS.get(key))) return fail(c, 'not-found', 404);
  await c.env.ORDERS.delete(key);
  c.log.info('account.removed', { account: mail });
  return new Response(null, { status: 204 });
}

// PUT /api/admin/media: the same upload as the inventory app, for the CLI.
export async function uploadMediaAdminRoute(req, c) {
  const refused = await denied(req, c);
  if (refused) return refused;
  const ref = await uploadPhoto(req, c.env.MEDIA);
  c.log.info('media.uploaded', { photo: ref.id });
  return json(ref, 200, noStore);
}

const refShape = r => !!r && typeof r === 'object' && Array.isArray(r.widths) && r.widths.length > 0
  && r.widths.every(w => MEDIA_NAME.test(`${r.id}-${w}.${r.ext}`));
const loadDoc = async (env, key, code) => {
  const { value, version } = await env.ORDERS.getEntry(key);
  if (!value) throw new HttpError(code, 404);
  return { doc: JSON.parse(value), version };
};

// POST /api/admin/photos { era, target, color?, refs } → { product | era, version }: attaches uploaded photos to a
// product (a colour's, or its shared ones) or sets the era hero when target is 'hero'. Retries a lost version race.
export async function attachPhotosRoute(req, c) {
  const refused = await denied(req, c);
  if (refused) return refused;
  const { era, target, color, refs } = (await readJson(req, 65536)) ?? {};
  const bad = () => new HttpError('invalid-photo', 400);
  if (typeof era !== 'string' || typeof target !== 'string' || (color !== undefined && typeof color !== 'string')
    || !Array.isArray(refs) || !refs.length || refs.length > 30 || !refs.every(refShape)) throw bad();
  if (target === 'hero' && (refs.length !== 1 || color !== undefined)) throw bad();
  for (const r of refs) for (const w of r.widths) if (!(await c.env.MEDIA.has(`${r.id}-${w}.${r.ext}`))) throw bad();
  let last;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const opId = crypto.randomUUID(); // per attempt: a retry re-reads and must not replay the lost one
      if (target === 'hero') {
        const { doc, version } = await loadDoc(c.env, eraKey(era), 'unknown-era');
        const saved = await saveEra(c.env, { opId, era: { ...doc, hero: refs[0] }, version, now: c.now });
        c.log.info('photos.attached', { era, target });
        return json({ era: saved.era, version: saved.version }, 200, noStore);
      }
      const { doc, version } = await loadDoc(c.env, productKey(target), 'unknown-product');
      if (doc.era !== era) throw new HttpError('unknown-product', 404);
      const perColor = doc.colors.some(x => x.images !== undefined);
      const col = color === undefined ? undefined : doc.colors.find(x => x.name === color);
      if ((color !== undefined && !col) || (color === undefined && perColor)) throw bad();
      const add = list => [...(list ?? []), ...refs.filter(r => !(list ?? []).some(x => x.id === r.id))];
      const product = col
        ? { ...doc, colors: doc.colors.map(x => (x === col ? { ...x, images: add(x.images) } : x)) }
        : { ...doc, images: add(doc.images) };
      const saved = await saveProduct(c.env, { opId, product, version, by: null, now: c.now });
      c.log.info('photos.attached', { era, target, color });
      return json({ product: saved.product, version: saved.version }, 200, noStore);
    } catch (err) {
      if (!(err instanceof HttpError) || !['product-changed', 'era-changed'].includes(err.code)) throw err;
      last = err;
    }
  }
  throw last;
}
