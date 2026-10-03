import { createApp } from '../../worker/src/index.js';
import { FIXTURE, NOW } from './fixture.mjs';

// In-memory stand-in for a KV namespace. Set `failPuts` / `failGets` to a predicate on the key to simulate outages.
export function fakeKV() {
  const store = new Map();
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
    async put(key, value, opts = {}) {
      if (this.failPuts?.(key)) throw new Error('KV put failed');
      store.set(key, { value: String(value), opts });
    },
    async delete(key) { store.delete(key); },
    async list({ prefix = '' } = {}) {
      const keys = [...store.keys()].filter(k => k.startsWith(prefix)).sort().map(name => ({ name }));
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
  return {
    ENVIRONMENT: 'production',
    PAYPAL_ENV: 'sandbox',
    PAYPAL_CLIENT_ID: 'client-id',
    PAYPAL_CLIENT_SECRET: 'client-secret',
    ORDER_HMAC_KEY: 'hmac-test-key',
    RESEND_API_KEY: 're_test',
    EMAIL_FROM: 'Evincus <orders@evincus.shop>',
    OWNER_EMAIL: 'owner@evincus.shop',
    SHIPPING_USD: '5',
    ALLOWED_ORIGINS: 'https://evincus.shop,https://jojo6550.github.io',
    COMMIT_SHA: 'abc1234',
    ORDERS: fakeKV(),
    BEACON_LIMIT: fakeLimiter(10),
    ...over,
  };
}

// ctx.waitUntil collector; settle() also drains work queued by queued work.
export function makeCtx() {
  const pending = [];
  return {
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

// One request through the Worker, with waitUntil work finished before returning.
export async function call(method, path, { body, raw, headers = {}, env = makeEnv(), clock = () => NOW, data = FIXTURE } = {}) {
  const app = createApp({ data, clock });
  const ctx = makeCtx();
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
