import { createApp } from '../../server/index.js';
import { FIXTURE, NOW } from './fixture.mjs';
import { OrderSubmission } from '../../server/lib/submissions.js';

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
    PAYMENT_MODE: 'paypal', // Legacy payment tests explicitly exercise the optional PayPal mode.
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
  const objects = new Map();
  env.ORDER_SUBMISSIONS ??= {
    idFromName: name => name,
    get(id) {
      if (!objects.has(id)) {
        const store = new Map();
        let serial = Promise.resolve();
        const state = { storage: { get: async k => structuredClone(store.get(k)), put: async (k, v) => store.set(k, structuredClone(v)), setAlarm: async () => {}, deleteAll: async () => store.clear() },
          blockConcurrencyWhile(fn) { const result = serial.then(fn); serial = result.catch(() => {}); return result; } };
        objects.set(id, new OrderSubmission(state, env));
      }
      return { fetch: (url, init) => objects.get(id).fetch(new Request(url, init)) };
    },
  };
  return env;
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

// Fake PayPal + Resend on globalThis.fetch.
// paypal: { down, decline, paidValue, payer, networkAfterCapture, captureStatus, createTime, captureErrors, chargeOnError } ; resend: { fail(body) → boolean }
// captureErrors: HTTP statuses returned by successive capture calls before captures succeed (e.g. [500, 500]).
// chargeOnError: the order still becomes COMPLETED at PayPal when a capture call returns one of those errors.
export function fakeUpstreams({ paypal = {}, resend = {} } = {}) {
  const orders = new Map();
  const captureErrors = [...(paypal.captureErrors ?? [])];
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

    if (paypal.down) return reply({ name: 'INTERNAL_SERVER_ERROR' }, 500);
    if (u.pathname === '/v1/oauth2/token') return reply({ access_token: 'token' });
    if (u.pathname === '/v2/checkout/orders' && method === 'POST') {
      const id = `ORDER${orders.size + 1}ABCDEFG`;
      orders.set(id, { id, status: 'APPROVED', ...JSON.parse(init.body) });
      return reply({ id });
    }
    const m = u.pathname.match(/^\/v2\/checkout\/orders\/(\w+)(\/capture)?$/);
    const order = m && orders.get(m[1]);
    if (!order) return reply({ name: 'RESOURCE_NOT_FOUND' }, 404);
    if (!m[2]) return reply(order);
    if (paypal.decline) return reply({ name: 'UNPROCESSABLE_ENTITY' }, 422);
    const unit = order.purchase_units[0];
    const amount = paypal.paidValue ? { ...unit.amount, value: paypal.paidValue } : unit.amount;
    const done = {
      id: order.id,
      status: 'COMPLETED',
      payer: 'payer' in paypal ? paypal.payer : { name: { given_name: 'Ann', surname: 'Lee' }, email_address: 'ann@example.com' },
      purchase_units: [{
        ...unit,
        shipping: { name: { full_name: 'Ann Lee' }, address: { address_line_1: '1 Main St', admin_area_2: 'Kingston', country_code: 'JM' } },
        payments: { captures: [{ id: 'CAPTURE1', status: paypal.captureStatus ?? 'COMPLETED', amount, ...(paypal.createTime ? { create_time: paypal.createTime } : {}) }] },
      }],
    };
    const errorStatus = captureErrors.shift();
    if (errorStatus !== undefined) {
      if (paypal.chargeOnError) orders.set(order.id, { ...order, ...done });
      return reply({ name: errorStatus >= 500 ? 'INTERNAL_SERVER_ERROR' : 'INVALID_REQUEST' }, errorStatus);
    }
    orders.set(order.id, { ...order, ...done }); // later GETs see the captured order, as at PayPal
    if (paypal.networkAfterCapture) throw new TypeError('network down after charge');
    return reply(done);
  };
  return { orders, calls, emails, captures: () => calls.filter(c => c.path.endsWith('/capture')) };
}
