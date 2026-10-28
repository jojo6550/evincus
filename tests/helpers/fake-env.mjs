import { createApp } from '../../server/index.js';
import { FIXTURE, NOW, fixtureStock } from './fixture.mjs';
import { applyStock } from '../../data/catalog.js';
import { MEDIA_NAME } from '../../server/lib/media.js';
import { REV_KEY, ERA_ORDER_KEY, eraKey, productKey } from '../../server/lib/catalog-store.js';
import { stockKey, stockDoc } from '../../server/lib/stock.js';

// In-memory stand-in for the ORDERS store (server/lib/kv-store.js has the same surface).
// Set `failPuts` / `failGets` to a predicate on the key to simulate outages.
export function fakeKV({ pageSize = 1000 } = {}) {
  const store = new Map();
  const versions = new Map();
  let clock = 0;
  // Versions are 20 hex digits, like Deno versionstamps. Keys a test put straight into `store` count as present, at version 0.
  const stamp = n => String(n).padStart(20, '0');
  const versionOf = key => versions.get(key) ?? (store.has(key) ? stamp(0) : null);
  const write = (key, value, opts = {}) => { store.set(key, { value: String(value), opts }); versions.set(key, stamp(++clock)); };
  const remove = key => { store.delete(key); versions.delete(key); };
  return {
    store,
    failPuts: null,
    failGets: null,
    async get(key, type) {
      if (this.failGets?.(key)) throw new Error('KV get failed');
      if (!store.has(key)) return null;
      const { value } = store.get(key);
      return type === 'json' ? JSON.parse(value) : value;
    },
    async getEntry(key) {
      if (this.failGets?.(key)) throw new Error('KV get failed');
      return { value: store.has(key) ? store.get(key).value : null, version: versionOf(key) };
    },
    async put(key, value, opts = {}) {
      if (this.failPuts?.(key)) throw new Error('KV put failed');
      write(key, value, opts);
    },
    async delete(key) { remove(key); },
    // All or nothing, with no await between the checks and the writes, like a Deno KV atomic commit.
    async commit({ checks = [], puts = [], deletes = [] } = {}) {
      // File-backed @deno/kv's limits, so unit tests catch a write that could never commit.
      if (checks.length > 10) throw new Error('TooManyChecks');
      if (puts.length + deletes.length > 1000) throw new Error('TooManyMutations');
      for (const { key } of puts) if (this.failPuts?.(key)) throw new Error('KV put failed');
      if (!checks.every(({ key, version }) => versionOf(key) === (version ?? null))) return false;
      for (const { key, value, opts } of puts) write(key, value, opts);
      for (const key of deletes) remove(key);
      return true;
    },
    async list({ prefix = '', cursor, limit = pageSize } = {}) {
      const all = [...store.keys()].filter(k => k.startsWith(prefix)).sort().map(name => ({ name, ...(store.get(name).opts.metadata && { metadata: store.get(name).opts.metadata }) }));
      const at = Number(cursor ?? 0);
      const keys = all.slice(at, at + Math.min(limit, pageSize));
      const end = at + keys.length;
      return end >= all.length ? { keys, list_complete: true } : { keys, list_complete: false, cursor: String(end) };
    },
  };
}

export function fakeLimiter(limit) {
  const hits = new Map();
  return {
    async limit({ key }) {
      const n = (hits.get(key) ?? 0) + 1;
      hits.set(key, n);
      return { success: n <= limit };
    },
  };
}

// In-memory stand-in for server/lib/media.js mediaStore.
export function fakeMedia() {
  const files = new Map();
  const check = name => { if (!MEDIA_NAME.test(name)) throw new Error('bad media name'); return name; };
  return {
    files,
    async read(name) { return files.get(check(name)) ?? null; },
    async write(name, bytes) { if (!files.has(check(name))) files.set(name, new Uint8Array(bytes)); },
    async has(name) { return files.has(check(name)); },
    async list() { return [...files.keys()].sort().map(name => ({ name, mtimeMs: 0 })); },
    async remove(name) { files.delete(check(name)); },
  };
}

export function makeEnv(over = {}) {
  const env = {
    ENVIRONMENT: 'production',
    NEWSLETTER_KEY: 'hmac-test-key',
    RESEND_API_KEY: 're_test',
    EMAIL_FROM: 'Evincus <no-reply@evincus.shop>',
    OWNER_EMAIL: 'owner@evincus.shop',
    ALLOWED_ORIGINS: 'https://evincus.shop',
    COMMIT_SHA: 'abc1234',
    ORDERS: fakeKV(),
    BEACON_LIMIT: fakeLimiter(10),
    LOGIN_IP_LIMIT: fakeLimiter(10),
    LOGIN_EMAIL_LIMIT: fakeLimiter(5),
    INVENTORY_LIMIT: fakeLimiter(120),
    MEDIA: fakeMedia(),
    ...over,
  };
  for (const [k, v] of fixtureStock()) putStock(env, k, v.onHand, v.committed);
  return env;
}

// Product ids never hold '|', so a line key splits at its first one into product and '<colour>|<size>'.
const splitLine = lineKey => [lineKey.slice(0, lineKey.indexOf('|')), lineKey.slice(lineKey.indexOf('|') + 1)];
const stockDocOf = (env, productId) => JSON.parse(env.ORDERS.store.get(stockKey(productId))?.value ?? '{}');

// Sets one variant in its product's stock document, bumping its version like any write. fakeKV's put writes before
// its first await, so callers that don't await it still see the change.
export function putStock(env, lineKey, onHand, committed = 0) {
  const [id, variant] = splitLine(lineKey);
  return env.ORDERS.put(stockKey(id), stockDoc({ ...stockDocOf(env, id), [variant]: { onHand, committed } }));
}

export const stockOf = (env, lineKey) => { const [id, variant] = splitLine(lineKey); return stockDocOf(env, id)[variant]; };

// ctx.waitUntil collector; settle() also drains work queued by queued work. `ip` is the client address the runtime saw.
export function makeCtx(ip) {
  const pending = [];
  return {
    ip,
    waitUntil: p => { pending.push(p); },
    async settle() { while (pending.length) await pending.shift(); },
  };
}

// Collects JSON log lines written with console.log until restore().
export function captureLogs() {
  const lines = [];
  const original = console.log;
  console.log = (...args) => {
    try { lines.push(JSON.parse(args[0])); } catch { original(...args); }
  };
  return { lines, restore() { console.log = original; } };
}

// One request through the app, with waitUntil work finished before returning.
async function send(app, method, path, { body, raw, headers = {}, ip, env = makeEnv() } = {}) {
  const ctx = makeCtx(ip);
  const init = { method, headers: { ...headers } };
  if (raw !== undefined) init.body = raw;
  else if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers['Content-Type'] = 'application/json';
  }
  const res = await app.fetch(new Request('https://api.test' + path, init), env, ctx);
  await ctx.settle();
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { res, status: res.status, json, text, env };
}

export const call = (method, path, { clock = () => NOW, data = applyStock(FIXTURE, fixtureStock()), ...opts } = {}) =>
  send(createApp({ data, clock }), method, path, opts);

// As the live server runs: the catalog comes from env.ORDERS.
export const callWithoutData = (method, path, { clock = () => NOW, ...opts } = {}) => send(createApp({ clock }), method, path, opts);

// Stores a catalog as seedCatalog does: every image becomes a photo ref, eras are published, and products are active
// with skus, costCents and the stock settings.
export async function seedFromFixture(env, data = FIXTURE) {
  const ids = new Map();
  const ref = src => {
    if (!ids.has(src)) ids.set(src, String(ids.size + 1).padStart(24, '0'));
    return { id: ids.get(src), width: 960, height: 1200, widths: [480, 960], ext: 'webp' };
  };
  const puts = [
    ...data.eras.map(e => ({ key: eraKey(e.slug), value: JSON.stringify({ state: 'published', ...e, hero: ref(e.hero) }) })),
    ...data.products.map((p, position) => ({ key: productKey(p.id), value: JSON.stringify({
      status: 'active', continueSelling: false, lowStockAt: 3, ...p, ...(p.images && { images: p.images.map(ref) }),
      colors: p.colors.map(c => (c.images ? { ...c, images: c.images.map(ref) } : c)),
      skus: {}, costCents: 1200, position,
    }) })),
    { key: ERA_ORDER_KEY, value: JSON.stringify(data.eras.map(e => e.slug)) },
    { key: REV_KEY, value: JSON.stringify({ rev: crypto.randomUUID() }) },
  ];
  await env.ORDERS.commit({ puts });
}

// Fake Resend on globalThis.fetch. resend: { fail(body) → boolean }
export function fakeUpstreams({ resend = {} } = {}) {
  const calls = [];
  const emails = [];
  const batchKeys = new Set();
  globalThis.fetch = async (input, init = {}) => {
    const u = new URL(typeof input === 'string' ? input : input.url);
    const method = init.method ?? 'GET';
    const headers = new Headers(init.headers);
    calls.push({ method, host: u.host, path: u.pathname, headers });
    const reply = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

    if (u.host === 'api.resend.com') {
      const body = JSON.parse(init.body);
      if (resend.fail?.(body)) return reply({ message: 'failed' }, 500);
      const idempotencyKey = headers.get('Idempotency-Key');
      if (u.pathname === '/emails/batch') {
        // Like Resend: a repeated idempotency key sends nothing new.
        if (!batchKeys.has(idempotencyKey)) {
          batchKeys.add(idempotencyKey);
          for (const e of body) emails.push({ ...e, idempotencyKey, batch: true });
        }
        return reply({ data: body.map((_, i) => ({ id: `em_b${i}` })) });
      }
      emails.push({ ...body, idempotencyKey });
      return reply({ id: `em_${emails.length}` });
    }
    return reply({ name: 'RESOURCE_NOT_FOUND' }, 404);
  };
  return { calls, emails };
}
