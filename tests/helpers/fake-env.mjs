import { createApp } from '../../server/index.js';
import { FIXTURE, NOW } from './fixture.mjs';

// In-memory stand-in for the ORDERS store (server/lib/kv-store.js has the same surface).
// Set `failPuts` / `failGets` to a predicate on the key to simulate outages.
export function fakeKV() {
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
      for (const { key } of puts) if (this.failPuts?.(key)) throw new Error('KV put failed');
      if (!checks.every(({ key, version }) => versionOf(key) === (version ?? null))) return false;
      for (const { key, value, opts } of puts) write(key, value, opts);
      for (const key of deletes) remove(key);
      return true;
    },
    async list({ prefix = '' } = {}) {
      const keys = [...store.keys()].filter(k => k.startsWith(prefix)).sort().map(name => ({ name, ...(store.get(name).opts.metadata && { metadata: store.get(name).opts.metadata }) }));
      return { keys, list_complete: true };
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
    ...over,
  };
  return env;
}

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
export async function call(method, path, { body, raw, headers = {}, ip, env = makeEnv(), clock = () => NOW, data = FIXTURE } = {}) {
  const app = createApp({ data, clock });
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
