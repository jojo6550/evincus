# Deno Deploy Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve the Evincus site and its `/api/*` from one Deno Deploy app, replacing the Cloudflare Worker, KV, Durable Object, rate limiters, cron and GitHub Pages.

**Architecture:** `server/` (moved from `worker/src/`) stays runtime-neutral and keeps its Node tests. A Cloudflare-KV-shaped adapter over Deno KV keeps every lib's `env.ORDERS.get/put/delete/list` call unchanged, and adds `getEntry`/`commit` for compare-and-set. Order submission becomes one atomic commit. `main.js` is the only Deno-specific file: it opens KV, builds `env`, registers `Deno.cron`, and routes `/api/*` to the app and everything else to an allowlisted static server.

**Tech Stack:** Deno ≥ 2.4 (Deno KV, `Deno.cron`, `Deno.serve`), Node 22 `node:test`, `@deno/kv` npm package (dev only, for real in-memory Deno KV in Node tests), vanilla ES modules.

**Spec:** `docs/superpowers/specs/2026-10-08-deno-deploy-design.md`

## Global Constraints

- Node ≥ 22 runs tests and scripts (`node --test`); Deno ≥ 2.4 runs the app. Deno 2.7.14 is installed on the dev machine.
- Only `main.js` may use `Deno.*`. Files in `server/` use web-standard APIs only (fetch, Request, Response, crypto, TextEncoder/TextDecoder, URL); no `node:` imports, no `Buffer`, no `process`.
- No new runtime dependencies. The only new devDependency is `@deno/kv` (`^0.14.0`). `wrangler` is removed.
- Payment and order paths stay idempotent and race-free: one checkout token can never produce two orders or a half-saved order.
- Deno KV limits: value ≤ 65 536 bytes serialized, one atomic commit ≤ 819 200 bytes and ≤ 1000 mutations. The adapter chunks at `CHUNK = 60_000` UTF-8 bytes, at most 12 chunks.
- Production URL: `https://evincus.jojo6550.deno.net`. Local server: `http://localhost:8000`.
- HTML/CSS/JS rule from the user: no inline CSS or JS in HTML; CSS only in `assets/css`, JS only in `assets/js`.
- Code style: 2-space indent, single quotes, semicolons, sparse comments that explain why, existing naming. Match the surrounding file.
- All 161 existing tests keep passing after every task (`node --test` prints `# fail 0`).
- Every commit message ends with:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
- Work on branch `dev`.

## Review Focus

1. **An expired entry that Deno has not deleted yet:** `getEntry` returns `value: null` with a non-null `version`. Callers must check against the version they read, not a literal `null`, or that checkout token can never be used again. Tests: Task 4 (adapter: expired entry, commit with the returned version succeeds and commit with `null` fails), Task 3 (`submitOrder` passes the version from `getEntry`).
2. **Chunk set missing under an unchanged head** (a racing overwrite or a corrupt store): reads retry, then throw. They never return partial text. Test: Task 4.
3. **Static path tricks** (encoded `..`, backslashes, dot-files, directory paths, `/README.md`, `/.env`, `/server/*`): the response must be a 404, never a file outside the allowlist. Tests: Task 7.
4. **Admin auth edge cases:** `Authorization: Bearer ` with an empty token, a lowercase `bearer`, a token that is one character longer, and a correct-looking header when `ADMIN_TOKEN` is unset (that case must be 404, not 401). Tests: Task 6.
5. **Rate limiter under concurrency:** parallel hits never exceed the limit, and refused hits write nothing, so a flood can't extend its own window. Test: Task 5.

---

## File map

| Path | Task | Responsibility |
|---|---|---|
| `server/**` (moved from `worker/src/**`) | 1 | API router, routes, libs, emails |
| `server/index.js` | 2, 3, 6 | `c.ip`, random `reqId`, admin routes |
| `server/routes/{checkout,newsletter,beacon}.js` | 2, 3 | Read `c.ip`; checkout calls `submitOrder` |
| `server/lib/orders.js` | 3 | `dayKey(record)` |
| `server/lib/submissions.js` | 3 | `submitOrder()` replaces the `OrderSubmission` Durable Object |
| `server/lib/kv-store.js` | 4 | Cloudflare-KV-shaped adapter over Deno KV |
| `server/lib/limiter.js` | 5 | KV fixed-window rate limiter |
| `server/routes/admin.js` | 6 | `GET/PUT /api/admin/sales` |
| `server/lib/http.js` | 6 | New error messages |
| `server/static.js` | 7 | Allowlisted static file server |
| `403/404/500/502/503/504.html` | 7 | `<base href="/">` |
| `main.js`, `deno.json`, `.env.example` | 8 | Deno entry and local dev |
| `scripts/error.mjs` | 8 | Prints the local `/__error/<code>` URL |
| `scripts/discount.mjs` | 9 | HTTP client for the admin endpoint |
| `tests/helpers/fake-env.mjs` | 2, 3 | `ip` on ctx, `fakeKV.getEntry/commit`, no Durable Object |
| `tests/helpers/deno-kv.mjs` | 4 | In-memory Deno KV for tests |
| `.github/workflows/ci.yml` | 10 | Tests only |
| `README.md` | 10 | Deno setup |

Deleted along the way: `worker/` (Task 1 moves `src`, Task 10 deletes the rest), `scripts/dev.mjs` (8), `assets/js/config.example.js` (10), `.github/workflows/deploy.yml` (10).

---

### Task 1: Move `worker/src` to `server/`

**Files:**
- Move: `worker/src/**` → `server/**`
- Modify: every `server/**/*.js` that imports from `data/`; `tests/*.mjs` and `tests/helpers/*.mjs` imports; `worker/wrangler.toml` `main`

**Interfaces:**
- Consumes: nothing.
- Produces: the module paths every later task uses: `server/index.js` (`createApp`), `server/lib/*.js`, `server/routes/*.js`, `server/emails/*.js`. Files in `server/lib|routes|emails` import data as `../../data/...`; `server/index.js` imports `../data/...`.

- [ ] **Step 1: Move the folder**

```bash
git mv worker/src server
```

- [ ] **Step 2: Fix relative imports**

Run these one at a time, in this order. The first command only matches `../../../`, so it never touches `server/index.js`.

```bash
sed -i "s#'\.\./\.\./\.\./data/#'../../data/#g" server/lib/*.js server/routes/*.js server/emails/*.js
sed -i "s#'\.\./\.\./data/#'../data/#g" server/index.js
sed -i "s#\.\./worker/src/#../server/#g" tests/*.mjs
sed -i "s#\.\./\.\./worker/src/#../../server/#g" tests/helpers/*.mjs
sed -i 's#^main = "src/index.js"#main = "../server/index.js"#' worker/wrangler.toml
```

- [ ] **Step 3: Check that no old path is left**

Run: `grep -rn "worker/src\|'\.\./\.\./\.\./" server tests scripts`
Expected: no output.

- [ ] **Step 4: Run the whole suite**

Run: `node --test 2>&1 | grep -E "^# (tests|pass|fail)"`
Expected: `# tests 161`, `# pass 161`, `# fail 0`

- [ ] **Step 5: Commit**

```bash
git add -A server tests worker/wrangler.toml
git commit -m "Move the API from worker/src to server/

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Client IP and request id come from the runtime, not headers

**Files:**
- Modify: `server/index.js` (the `fetch` handler's `reqId` and `c`)
- Modify: `server/routes/checkout.js:15-18`, `server/routes/newsletter.js:12-15`, `server/routes/beacon.js:9-10`
- Modify: `tests/helpers/fake-env.mjs` (`makeCtx`, `call`)
- Test: `tests/beacon.test.mjs`, `tests/routes-catalog.test.mjs`

**Interfaces:**
- Consumes: Task 1 paths.
- Produces: `createApp().fetch(req, env, ctx)` where `ctx = { waitUntil(p), ip?: string }`. Inside handlers, `c.ip` is a string (`ctx.ip ?? 'unknown'`). Test helpers: `makeCtx(ip?)` returns `{ ip, waitUntil, settle }`, and `call(method, path, { ..., ip })` passes `ip` through.

- [ ] **Step 1: Update the beacon tests and add a spoofing test**

In `tests/beacon.test.mjs`, replace the `send` helper (lines 5-6):

```js
const send = (body, env = makeEnv(), ip = '1.2.3.4') =>
  call('POST', '/api/beacon', { raw: typeof body === 'string' ? body : JSON.stringify(body), env, ip });
```

In the last test, replace `await send({ event: 'api-unreachable' }, env, { 'CF-Connecting-IP': '5.6.7.8' })` with `await send({ event: 'api-unreachable' }, env, '5.6.7.8')`.

Append:

```js
test('the client IP comes from the connection, not a spoofable header', async () => {
  const env = makeEnv();
  for (let i = 0; i < 10; i++) await send({ event: 'api-unreachable' }, env);
  const spoofed = await call('POST', '/api/beacon', { raw: JSON.stringify({ event: 'api-unreachable' }), env, ip: '1.2.3.4', headers: { 'CF-Connecting-IP': '9.9.9.9' } });
  assert.equal(spoofed.status, 429);
});
```

Append to `tests/routes-catalog.test.mjs`:

```js
test('request ids are random UUIDs, never taken from request headers', async () => {
  const r = await call('GET', '/api/health', { headers: { 'cf-ray': 'ray-123' } });
  assert.match(r.res.headers.get('x-request-id'), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});
```

- [ ] **Step 2: Pass `ip` through the test helpers**

In `tests/helpers/fake-env.mjs`, replace `makeCtx`:

```js
// ctx.waitUntil collector; settle() also drains work queued by queued work. `ip` is the client address the runtime saw.
export function makeCtx(ip) {
  const pending = [];
  return {
    ip,
    waitUntil: p => { pending.push(p); },
    async settle() { while (pending.length) await pending.shift(); },
  };
}
```

In `call`, add `ip` to the destructured options and pass it on:

```js
export async function call(method, path, { body, raw, headers = {}, ip, env = makeEnv(), clock = () => NOW, data = FIXTURE } = {}) {
  const app = createApp({ data, clock });
  const ctx = makeCtx(ip);
```

(The rest of `call` is unchanged.)

- [ ] **Step 3: Run the new tests to see them fail**

Run: `node --test tests/beacon.test.mjs tests/routes-catalog.test.mjs 2>&1 | grep -E "^not ok|# fail"`
Expected: failures for `more than 10 beacons a minute from one IP are 429`, `the client IP comes from the connection, not a spoofable header` and `request ids are random UUIDs, never taken from request headers`.

- [ ] **Step 4: Implement**

In `server/index.js`, replace

```js
      const reqId = req.headers.get('cf-ray') ?? crypto.randomUUID();
```

with

```js
      const reqId = crypto.randomUUID();
```

and replace the `const c = ...` line in `fetch` with

```js
      const c = { env, data, now: new Date(clock()), reqId, log, ip: ctx.ip ?? 'unknown', waitUntil: p => ctx.waitUntil(p), params: [] };
```

In `server/routes/checkout.js`, replace

```js
    const result = await c.env.ORDER_LIMIT.limit({ key: req.headers.get('CF-Connecting-IP') ?? 'unknown' });
```

with

```js
    const result = await c.env.ORDER_LIMIT.limit({ key: c.ip });
```

In `server/routes/newsletter.js`, replace

```js
    const { success } = await c.env.ORDER_LIMIT.limit({ key: `newsletter:${req.headers.get('CF-Connecting-IP') ?? 'unknown'}` });
```

with

```js
    const { success } = await c.env.ORDER_LIMIT.limit({ key: `newsletter:${c.ip}` });
```

In `server/routes/beacon.js`, replace the two lines

```js
  const ip = req.headers.get('CF-Connecting-IP') ?? 'unknown';
  const { success } = await c.env.BEACON_LIMIT.limit({ key: ip });
```

with

```js
  const { success } = await c.env.BEACON_LIMIT.limit({ key: c.ip });
```

- [ ] **Step 5: Run the whole suite**

Run: `node --test 2>&1 | grep -E "^# (tests|pass|fail)"`
Expected: `# tests 163`, `# fail 0`

Run: `grep -rn "CF-Connecting-IP\|cf-ray" server`
Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add server tests
git commit -m "Take client IP and request id from the runtime instead of Cloudflare headers

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: `submitOrder` replaces the Durable Object

**Files:**
- Modify: `tests/helpers/fake-env.mjs` (`fakeKV` gains `getEntry`/`commit`; remove the Durable Object)
- Modify: `server/lib/orders.js` (add `dayKey`)
- Rewrite: `server/lib/submissions.js`
- Modify: `server/routes/checkout.js` (`placeOrderRoute`)
- Modify: `server/index.js` (remove `export { OrderSubmission }`)
- Test: `tests/submissions.test.mjs` (new), existing `tests/checkout.test.mjs` must keep passing unchanged

**Interfaces:**
- Consumes: `orderKey(id)` and `ORDER_TTL` from `server/lib/orders.js`.
- Produces:
  - Storage contract that `kvStore` (Task 4) also implements:
    - `env.ORDERS.getEntry(key) → Promise<{ value: string|null, version: string|null }>`
    - `env.ORDERS.commit({ checks?: [{ key, version }], puts?: [{ key, value, opts? }], deletes?: [key] }) → Promise<boolean>`. `false` means a check failed and nothing was written. A write failure throws and writes nothing.
  - `dayKey(record) → 'day:<YYYY-MM-DD>:<id>'` (Jamaica day of `placedAt`, else UTC day of `capturedAt`).
  - `submissionKey(id) → 'submission:<id>'`
  - `submitOrder(env, id, fingerprint, record|null) → Promise<{ record: object|null } | { conflict: true }>`. Throws `Error('Order storage unavailable')` after 3 lost races.

- [ ] **Step 1: Write the failing tests**

Create `tests/submissions.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeKV } from './helpers/fake-env.mjs';
import { submitOrder } from '../server/lib/submissions.js';

const record = (over = {}) => ({ id: 'EV-1', placedAt: '2026-10-03T12:00:00.000Z', totalCents: 100, ...over });
const env = () => ({ ORDERS: fakeKV() });

test('the first submit writes the submission, order, day index and retry job together', async () => {
  const e = env();
  assert.deepEqual(await submitOrder(e, 'EV-1', 'fp', null), { record: null });
  assert.equal(e.ORDERS.store.size, 0);
  assert.deepEqual(await submitOrder(e, 'EV-1', 'fp', record()), { record: record() });
  assert.deepEqual([...e.ORDERS.store.keys()].sort(), ['day:2026-10-03:EV-1', 'email-retry:EV-1', 'order:EV-1', 'submission:EV-1']);
  assert.deepEqual(JSON.parse(e.ORDERS.store.get('email-retry:EV-1').value), { retries: 0, nextAt: Date.parse('2026-10-03T12:00:00.000Z') });
  assert.equal(e.ORDERS.store.get('order:EV-1').opts.expirationTtl, 63072000);
});

test('a replay returns the saved record and a different fingerprint conflicts', async () => {
  const e = env();
  await submitOrder(e, 'EV-1', 'fp', record());
  assert.deepEqual(await submitOrder(e, 'EV-1', 'fp', record({ totalCents: 999 })), { record: record() });
  assert.deepEqual(await submitOrder(e, 'EV-1', 'fp', null), { record: record() });
  assert.deepEqual(await submitOrder(e, 'EV-1', 'other', null), { conflict: true });
});

test('concurrent submits of one token produce one order', async () => {
  const e = env();
  const results = await Promise.all([1, 2, 3, 4, 5].map(n => submitOrder(e, 'EV-1', 'fp', record({ totalCents: n }))));
  const winner = results[0].record.totalCents;
  assert.ok(results.every(r => r.record.totalCents === winner));
  assert.equal(JSON.parse(e.ORDERS.store.get('order:EV-1').value).totalCents, winner);
});

test('a failed write saves nothing and the same submit then succeeds', async () => {
  const e = env();
  e.ORDERS.failPuts = key => key.startsWith('day:');
  await assert.rejects(submitOrder(e, 'EV-1', 'fp', record()), /KV put failed/);
  assert.equal(e.ORDERS.store.size, 0);
  e.ORDERS.failPuts = null;
  assert.deepEqual(await submitOrder(e, 'EV-1', 'fp', record()), { record: record() });
});

test('the commit checks the version that was read, so an expired leftover entry does not block the token', async () => {
  const e = env();
  e.ORDERS.getEntry = async () => ({ value: null, version: 'leftover' });
  const seen = [];
  e.ORDERS.commit = async ({ checks }) => { seen.push(...checks); return true; };
  await submitOrder(e, 'EV-1', 'fp', record());
  assert.deepEqual(seen, [{ key: 'submission:EV-1', version: 'leftover' }]);
});

test('repeated lost races give up instead of looping forever', async () => {
  const e = env();
  e.ORDERS.commit = async () => false;
  await assert.rejects(submitOrder(e, 'EV-1', 'fp', record()), /Order storage unavailable/);
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `node --test tests/submissions.test.mjs 2>&1 | grep -E "SyntaxError|does not provide|# fail"`
Expected: an import error, because `submitOrder` is not exported.

- [ ] **Step 3: Give `fakeKV` versions, `getEntry` and `commit`**

In `tests/helpers/fake-env.mjs`, replace the whole `fakeKV` function with:

```js
// In-memory stand-in for the ORDERS store (server/lib/kv-store.js has the same surface).
// Set `failPuts` / `failGets` to a predicate on the key to simulate outages.
export function fakeKV() {
  const store = new Map();
  const versions = new Map();
  let clock = 0;
  // Keys a test put straight into `store` count as present, at version '0'.
  const versionOf = key => versions.get(key) ?? (store.has(key) ? '0' : null);
  const write = (key, value, opts = {}) => { store.set(key, { value: String(value), opts }); versions.set(key, String(++clock)); };
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
```

In the same file, delete the `import { OrderSubmission } from '../../server/lib/submissions.js';` line, and in `makeEnv` delete everything from `const objects = new Map();` through the closing `};` of the `env.ORDER_SUBMISSIONS ??= { ... };` block, so `makeEnv` ends with:

```js
    ...over,
  };
  return env;
}
```

- [ ] **Step 4: Add `dayKey` to `server/lib/orders.js`**

Replace `saveOrder` with:

```js
// The Jamaica day an order was placed (UTC-5, no DST), or the UTC day a legacy PayPal order was captured.
export function dayKey(record) {
  const day = record.placedAt ? new Date(Date.parse(record.placedAt) - 5 * 3600000).toISOString().slice(0, 10) : record.capturedAt.slice(0, 10);
  return `day:${day}:${record.id}`;
}

export async function saveOrder(env, record) {
  await env.ORDERS.put(orderKey(record.id), JSON.stringify(record), { expirationTtl: ORDER_TTL });
  await env.ORDERS.put(dayKey(record), '', { expirationTtl: ORDER_TTL });
}
```

- [ ] **Step 5: Replace `server/lib/submissions.js`**

Replace the whole file with:

```js
import { ORDER_TTL, orderKey, dayKey } from './orders.js';

export const submissionKey = id => `submission:${id}`;
const ROUNDS = 3;

// One order per checkout token. The submission, the order, its day index and its email retry job land in one
// atomic commit that only succeeds while the submission is unchanged since it was read, so double clicks and network
// retries can't create a second order or a half-saved one. The retry job is written before the order is
// acknowledged, so a confirmation lost to a shutdown is still sent by the cron.
export async function submitOrder(env, id, fingerprint, record) {
  for (let round = 0; round < ROUNDS; round++) {
    const { value, version } = await env.ORDERS.getEntry(submissionKey(id));
    if (value) {
      const saved = JSON.parse(value);
      return saved.fingerprint === fingerprint ? { record: saved.record } : { conflict: true };
    }
    if (!record) return { record: null };
    const ttl = { expirationTtl: ORDER_TTL };
    const saved = await env.ORDERS.commit({
      checks: [{ key: submissionKey(id), version }],
      puts: [
        { key: submissionKey(id), value: JSON.stringify({ fingerprint, record }), opts: ttl },
        { key: orderKey(record.id), value: JSON.stringify(record), opts: ttl },
        { key: dayKey(record), value: '', opts: ttl },
        { key: `email-retry:${record.id}`, value: JSON.stringify({ retries: 0, nextAt: Date.parse(record.placedAt) }) },
      ],
    });
    if (saved) return { record };
  }
  throw new Error('Order storage unavailable');
}
```

- [ ] **Step 6: Use it in `server/routes/checkout.js`**

Replace the import `import { findOrder } from '../lib/orders.js';` with:

```js
import { findOrder } from '../lib/orders.js';
import { submitOrder } from '../lib/submissions.js';
```

In `placeOrderRoute`, replace everything from `const stub = c.env.ORDER_SUBMISSIONS.get(...)` through the `({ record } = await response.json());` line and its closing `}` with:

```js
  let result = await submitOrder(c.env, id, fingerprint, null);
  if (result.conflict) return fail(c, 'checkout-conflict', 409);
  let { record } = result;
  if (!record) {
    let q;
    try { q = quote(c.data, c.now, body?.items, checkoutShipping(c.env, details.fulfillment.type)); }
    catch (err) { if (err instanceof CartError) return fail(c, 'invalid-cart', 400); throw err; }
    // Never silently accept a changed price or capped quantity.
    if (!q.checkoutReady || q.lines.some(l => l.status !== 'ok') || body.expectedTotalCents !== q.totalCents) return fail(c, 'bag-changed', 409, { lines: q.lines });
    result = await submitOrder(c.env, id, fingerprint, directRecord(id, q, details, c.now));
    if (result.conflict) return fail(c, 'checkout-conflict', 409);
    ({ record } = result);
  }
```

The lines before (`const id = ...`) and after (`c.log.info('order.placed', ...)`) stay as they are.

- [ ] **Step 7: Remove the Durable Object export**

In `server/index.js`, delete the line `export { OrderSubmission } from './lib/submissions.js';`.

Run: `grep -rn "OrderSubmission\|ORDER_SUBMISSIONS\|blockConcurrencyWhile" server tests`
Expected: no output.

- [ ] **Step 8: Run the whole suite**

Run: `node --test 2>&1 | grep -E "^# (tests|pass|fail)"`
Expected: `# tests 169`, `# fail 0`. `tests/checkout.test.mjs` passes unchanged, including `concurrent submissions and later retries create one order and preserve its original time` and `storage failure never acknowledges an order and retry repairs its index`.

- [ ] **Step 9: Commit**

```bash
git add server tests
git commit -m "Replace the order Durable Object with one atomic KV commit

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Cloudflare-KV-shaped adapter over Deno KV

**Files:**
- Create: `server/lib/kv-store.js`
- Create: `tests/helpers/deno-kv.mjs`
- Test: `tests/kv-store.test.mjs`
- Modify: `package.json`, `package-lock.json` (devDependency `@deno/kv`)

**Interfaces:**
- Consumes: a `Deno.Kv` instance (real Deno, or `openKv()` from `@deno/kv` in tests).
- Produces: `kvStore(kv, { now? }) → { get, getEntry, put, delete, list, commit }`, with the same contract as `fakeKV` from Task 3:
  - `get(key, type?)`: `type` is `'text'` (default), `'json'`, or `{ type, cacheTtl }` (`cacheTtl` is ignored). Returns `null` when the key is missing or expired.
  - `put(key, value, { expirationTtl?, metadata? }?)`
  - `delete(key)`
  - `list({ prefix?, cursor?, limit = 1000 })` → `{ keys: [{ name, metadata? }], list_complete, cursor? }`
  - `getEntry(key)` → `{ value, version }`
  - `commit({ checks, puts, deletes })` → `boolean`
  - `export const CHUNK = 60_000`
- Test helper: `tests/helpers/deno-kv.mjs` exports `skip` (`false` or a reason string) and `memoryKv(t) → Promise<Deno.Kv>`, which closes itself after the test.

- [ ] **Step 1: Add the dev dependency**

```bash
npm install --save-dev @deno/kv@^0.14.0
```

Expected: `package.json` `devDependencies` lists `"@deno/kv": "^0.14.0"` next to `wrangler`.

- [ ] **Step 2: Write the test helper**

Create `tests/helpers/deno-kv.mjs`:

```js
// Real Deno KV, in memory, for Node tests (the @deno/kv npm package). Tests skip when its native build is missing
// on this machine; CI must run them, so there a missing build is an error.
let openKv;
try { ({ openKv } = await import('@deno/kv')); } catch { /* not installed for this platform */ }
if (!openKv && process.env.CI) throw new Error('@deno/kv failed to load in CI');

export const skip = openKv ? false : '@deno/kv native build not available';

export async function memoryKv(t) {
  const kv = await openKv();
  t.after(() => kv.close());
  return kv;
}
```

- [ ] **Step 3: Write the failing tests**

Create `tests/kv-store.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { skip, memoryKv } from './helpers/deno-kv.mjs';
import { kvStore, CHUNK } from '../server/lib/kv-store.js';

async function open(t) {
  const kv = await memoryKv(t);
  const clock = { t: Date.parse('2026-10-03T12:00:00Z') };
  return { kv, clock, s: kvStore(kv, { now: () => clock.t }) };
}

async function raw(kv, prefix) {
  const out = [];
  for await (const e of kv.list({ prefix })) out.push(e);
  return out;
}

test('text and json values round-trip; missing keys are null', { skip }, async t => {
  const { s } = await open(t);
  assert.equal(await s.get('nope'), null);
  await s.put('a', 'hello');
  await s.put('b', JSON.stringify({ n: 1 }));
  assert.equal(await s.get('a'), 'hello');
  assert.equal(await s.get('a', { type: 'text', cacheTtl: 30 }), 'hello');
  assert.deepEqual(await s.get('b', 'json'), { n: 1 });
  await s.put('a', 42);
  assert.equal(await s.get('a'), '42');
  await s.delete('a');
  assert.equal(await s.get('a'), null);
});

test('list filters by string prefix and returns metadata only where set', { skip }, async t => {
  const { s } = await open(t);
  await s.put('sub:b', '{}');
  await s.put('sub:a', '{}', { metadata: { email: 'a@x.test', status: 'active' } });
  await s.put('subscriber', '{}');
  await s.put('email-retry:1', '{}');
  const page = await s.list({ prefix: 'sub:' });
  assert.deepEqual(page, { keys: [{ name: 'sub:a', metadata: { email: 'a@x.test', status: 'active' } }, { name: 'sub:b' }], list_complete: true });
  assert.equal((await s.list()).keys.length, 4);
});

test('list pages with a cursor', { skip }, async t => {
  const { s } = await open(t);
  for (let i = 0; i < 5; i++) await s.put(`k:${i}`, String(i));
  const names = [];
  let cursor;
  let pages = 0;
  do {
    const page = await s.list({ prefix: 'k:', cursor, limit: 2 });
    names.push(...page.keys.map(k => k.name));
    cursor = page.list_complete ? undefined : page.cursor;
    pages++;
  } while (cursor);
  assert.deepEqual(names, ['k:0', 'k:1', 'k:2', 'k:3', 'k:4']);
  assert.equal(pages, 3);
});

test('expirationTtl is exact: gone from get and list the moment it passes', { skip }, async t => {
  const { s, clock } = await open(t);
  await s.put('alert:x', '1', { expirationTtl: 60 });
  clock.t += 59_000;
  assert.equal(await s.get('alert:x'), '1');
  clock.t += 1_000;
  assert.equal(await s.get('alert:x'), null);
  assert.deepEqual((await s.list({ prefix: 'alert:' })).keys, []);
});

test('an expired entry still has a version, and only that version unlocks it', { skip }, async t => {
  const { s, clock } = await open(t);
  await s.put('submission:1', 'old', { expirationTtl: 60 });
  clock.t += 61_000;
  const { value, version } = await s.getEntry('submission:1');
  assert.equal(value, null);
  assert.ok(version);
  assert.equal(await s.commit({ checks: [{ key: 'submission:1', version: null }], puts: [{ key: 'submission:1', value: 'new' }] }), false);
  assert.equal(await s.commit({ checks: [{ key: 'submission:1', version }], puts: [{ key: 'submission:1', value: 'new' }] }), true);
  assert.equal(await s.get('submission:1'), 'new');
});

test('values over 64 KiB are split into chunks and shrink back cleanly', { skip }, async t => {
  const { s, kv } = await open(t);
  const big = 'é'.repeat(100_000); // 200 000 UTF-8 bytes
  await s.put('nl-issue:2026-10-03', big, { metadata: { day: '2026-10-03' } });
  assert.equal(await s.get('nl-issue:2026-10-03'), big);
  const chunks = await raw(kv, ['c']);
  assert.equal(chunks.length, 4);
  assert.ok(chunks.every(c => c.value.length <= CHUNK));
  assert.deepEqual((await s.list({ prefix: 'nl-issue:' })).keys, [{ name: 'nl-issue:2026-10-03', metadata: { day: '2026-10-03' } }]);

  await s.put('nl-issue:2026-10-03', 'small');
  assert.equal(await s.get('nl-issue:2026-10-03'), 'small');
  assert.equal((await raw(kv, ['c'])).length, 0);

  await s.put('nl-issue:2026-10-03', big);
  await s.delete('nl-issue:2026-10-03');
  assert.equal(await s.get('nl-issue:2026-10-03'), null);
  assert.equal((await raw(kv, ['c'])).length, 0);
});

test('a missing chunk is an error, never partial text', { skip }, async t => {
  const { s, kv } = await open(t);
  await s.put('big', 'x'.repeat(3 * CHUNK));
  const [first] = await raw(kv, ['c']);
  await kv.delete(first.key);
  await assert.rejects(s.get('big'), /missing chunks/);
});

test('values and metadata past the limits are refused before anything is written', { skip }, async t => {
  const { s } = await open(t);
  await assert.rejects(s.put('huge', 'x'.repeat(12 * CHUNK + 1)), /over/);
  await assert.rejects(s.put('meta', '1', { metadata: { note: 'x'.repeat(1100) } }), /metadata/);
  assert.equal(await s.get('huge'), null);
  assert.equal(await s.get('meta'), null);
});

test('commit is compare-and-set on the version read', { skip }, async t => {
  const { s } = await open(t);
  const absent = await s.getEntry('config:sales');
  assert.deepEqual(absent, { value: null, version: null });
  assert.equal(await s.commit({ checks: [{ key: 'config:sales', version: null }], puts: [{ key: 'config:sales', value: '[1]' }, { key: 'other', value: 'x' }] }), true);
  assert.equal(await s.commit({ checks: [{ key: 'config:sales', version: null }], puts: [{ key: 'config:sales', value: '[2]' }, { key: 'other', value: 'y' }] }), false);
  assert.equal(await s.get('config:sales'), '[1]');
  assert.equal(await s.get('other'), 'x');
  const current = await s.getEntry('config:sales');
  assert.equal(current.value, '[1]');
  assert.equal(await s.commit({ checks: [{ key: 'config:sales', version: current.version }], deletes: ['other'], puts: [{ key: 'config:sales', value: '[3]' }] }), true);
  assert.equal(await s.get('config:sales'), '[3]');
  assert.equal(await s.get('other'), null);
  assert.equal(await s.commit({ checks: [{ key: 'config:sales', version: current.version }], puts: [{ key: 'config:sales', value: '[4]' }] }), false);
});
```

- [ ] **Step 4: Run them to see them fail**

Run: `node --test tests/kv-store.test.mjs 2>&1 | grep -E "Cannot find module|ERR_MODULE_NOT_FOUND|# fail"`
Expected: a module-not-found error for `server/lib/kv-store.js`.

- [ ] **Step 5: Implement `server/lib/kv-store.js`**

```js
// Cloudflare-KV-shaped storage over Deno KV, so the libs keep calling get/put/delete/list with string keys.
//
// Each key has a head entry ['s', key] → { v, m, x, n, id }:
//   v   the value as UTF-8 bytes, or null when it is split into chunks
//   m   metadata (returned by list), or null
//   x   expiry in epoch ms, or null. Expired entries read as missing, so TTLs are exact like Cloudflare's;
//       Deno's own expireIn is set too, only to clean them up.
//   n   chunk count, id  the chunk set's id
// Deno KV caps a value at 64 KiB, so bigger values go to ['c', key, id, i], written in the same atomic commit as
// their head. A chunk set is never changed, only replaced under a new id and deleted, so a reader that finds a
// chunk missing knows a newer write landed and reads again.
export const CHUNK = 60_000;
const MAX_CHUNKS = 12; // one atomic commit is capped at 800 KiB
const MAX_METADATA = 1024;
const ROUNDS = 5;
const enc = new TextEncoder();
const dec = new TextDecoder();

const headKey = key => ['s', key];
const chunkKey = (key, id, i) => ['c', key, id, i];

function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

// The first string that sorts after every string starting with `prefix`.
const after = prefix => prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1);

export function kvStore(kv, { now = Date.now } = {}) {
  const live = head => head !== null && (head.x === null || head.x > now());

  async function heads(keys) {
    const out = new Map();
    for (let i = 0; i < keys.length; i += 10) {
      const batch = keys.slice(i, i + 10);
      (await kv.getMany(batch.map(headKey))).forEach((entry, j) => out.set(batch[j], entry));
    }
    return out;
  }

  // The text a live head points at, or undefined when its chunk set is gone.
  async function text(key, head) {
    if (!head.n) return dec.decode(head.v);
    const keys = Array.from({ length: head.n }, (_, i) => chunkKey(key, head.id, i));
    const parts = [];
    for (let i = 0; i < keys.length; i += 10) {
      for (const entry of await kv.getMany(keys.slice(i, i + 10))) {
        if (entry.value === null) return undefined;
        parts.push(entry.value);
      }
    }
    return dec.decode(concat(parts));
  }

  async function getEntry(key) {
    for (let round = 0; round < ROUNDS; round++) {
      const entry = await kv.get(headKey(key));
      if (!live(entry.value)) return { value: null, version: entry.versionstamp };
      const value = await text(key, entry.value);
      if (value !== undefined) return { value, version: entry.versionstamp };
    }
    throw new Error(`KV value for ${key} is missing chunks`);
  }

  async function get(key, type = 'text') {
    const { value } = await getEntry(key);
    if (value === null) return null;
    return (typeof type === 'object' ? type?.type : type) === 'json' ? JSON.parse(value) : value;
  }

  function dropChunks(op, key, old) {
    for (let i = 0; i < (old?.n ?? 0); i++) op.delete(chunkKey(key, old.id, i));
  }

  function addPut(op, key, value, opts = {}, old) {
    const bytes = enc.encode(String(value));
    const m = opts.metadata ?? null;
    if (m !== null && enc.encode(JSON.stringify(m)).length > MAX_METADATA) throw new Error(`KV metadata for ${key} is over ${MAX_METADATA} bytes`);
    const ttl = opts.expirationTtl ? opts.expirationTtl * 1000 : null;
    const x = ttl === null ? null : now() + ttl;
    const options = ttl === null ? undefined : { expireIn: ttl };
    if (bytes.length <= CHUNK) {
      op.set(headKey(key), { v: bytes, m, x, n: 0, id: null }, options);
    } else {
      const n = Math.ceil(bytes.length / CHUNK);
      if (n > MAX_CHUNKS) throw new Error(`KV value for ${key} is over ${MAX_CHUNKS * CHUNK} bytes`);
      const id = crypto.randomUUID();
      // slice copies: a subarray view would serialize its whole backing buffer.
      for (let i = 0; i < n; i++) op.set(chunkKey(key, id, i), bytes.slice(i * CHUNK, (i + 1) * CHUNK), options);
      op.set(headKey(key), { v: null, m, x, n, id }, options);
    }
    dropChunks(op, key, old);
  }

  // One atomic write. `checks` compare a key's version (from getEntry) with what is stored now; on a mismatch
  // nothing is written and the result is false. Keys being written are also guarded, so the chunk sets deleted are
  // always the current ones; a clash on those alone is retried.
  async function commit({ checks = [], puts = [], deletes = [] } = {}) {
    const keys = [...new Set([...puts.map(p => p.key), ...deletes])];
    for (let round = 0; round < ROUNDS; round++) {
      const old = await heads(keys);
      const op = kv.atomic();
      for (const { key, version } of checks) op.check({ key: headKey(key), versionstamp: version ?? null });
      for (const key of keys) if (!checks.some(ch => ch.key === key)) op.check(old.get(key));
      for (const { key, value, opts } of puts) addPut(op, key, value, opts, old.get(key).value);
      for (const key of deletes) { op.delete(headKey(key)); dropChunks(op, key, old.get(key).value); }
      if ((await op.commit()).ok) return true;
      if (checks.length) {
        const current = await heads(checks.map(ch => ch.key));
        if (checks.some(ch => current.get(ch.key).versionstamp !== (ch.version ?? null))) return false;
      }
    }
    throw new Error('KV write kept conflicting');
  }

  async function list({ prefix = '', cursor, limit = 1000 } = {}) {
    const selector = prefix ? { start: headKey(prefix), end: headKey(after(prefix)) } : { prefix: ['s'] };
    const iter = kv.list(selector, { limit, cursor });
    const keys = [];
    let seen = 0;
    for await (const entry of iter) {
      seen++;
      if (live(entry.value)) keys.push(entry.value.m === null ? { name: entry.key[1] } : { name: entry.key[1], metadata: entry.value.m });
    }
    return seen < limit ? { keys, list_complete: true } : { keys, list_complete: false, cursor: iter.cursor };
  }

  return {
    get,
    getEntry,
    list,
    commit,
    put: async (key, value, opts) => { await commit({ puts: [{ key, value, opts }] }); },
    delete: async key => { await commit({ deletes: [key] }); },
  };
}
```

- [ ] **Step 6: Run the adapter tests**

Run: `node --test tests/kv-store.test.mjs 2>&1 | grep -E "^# (tests|pass|fail|skipped)"`
Expected: `# tests 9`, `# pass 9`, `# fail 0`, `# skipped 0`

- [ ] **Step 7: Check it against real Deno's size limits**

`@deno/kv` does not enforce the 64 KiB cap, so run one round-trip in real Deno:

```bash
deno eval --unstable-kv "import { kvStore } from './server/lib/kv-store.js'; const s = kvStore(await Deno.openKv(':memory:')); const big = 'é'.repeat(300000); await s.put('big', big, { metadata: { a: 1 } }); console.log((await s.get('big')) === big, (await s.list()).keys.length);"
```

Expected: `true 1`

- [ ] **Step 8: Run the whole suite**

Run: `node --test 2>&1 | grep -E "^# (tests|pass|fail)"`
Expected: `# tests 178`, `# fail 0`

- [ ] **Step 9: Commit**

```bash
git add server/lib/kv-store.js tests/kv-store.test.mjs tests/helpers/deno-kv.mjs package.json package-lock.json
git commit -m "Add a Cloudflare-KV-shaped store over Deno KV with chunking and compare-and-set

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Rate limiter in Deno KV

**Files:**
- Create: `server/lib/limiter.js`
- Test: `tests/limiter.test.mjs`

**Interfaces:**
- Consumes: a `Deno.Kv` instance; `tests/helpers/deno-kv.mjs` (`skip`, `memoryKv`) from Task 4.
- Produces: `kvLimiter(kv, name, { limit, period, now? }) → { limit({ key }) → Promise<{ success: boolean }> }`. `period` is in seconds. Storage key: `['rl', name, String(key), window]`, where `window = Math.floor(now() / (period * 1000))` and the value is the count as a number.

- [ ] **Step 1: Write the failing tests**

Create `tests/limiter.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { skip, memoryKv } from './helpers/deno-kv.mjs';
import { kvLimiter } from '../server/lib/limiter.js';

const hits = async (limiter, key, n) => {
  const out = [];
  for (let i = 0; i < n; i++) out.push((await limiter.limit({ key })).success);
  return out;
};

test('allows up to the limit per key and per name, then refuses', { skip }, async t => {
  const kv = await memoryKv(t);
  const order = kvLimiter(kv, 'order', { limit: 2, period: 60, now: () => 0 });
  const beacon = kvLimiter(kv, 'beacon', { limit: 2, period: 60, now: () => 0 });
  assert.deepEqual(await hits(order, '1.1.1.1', 3), [true, true, false]);
  assert.deepEqual(await hits(order, '2.2.2.2', 1), [true]);
  assert.deepEqual(await hits(beacon, '1.1.1.1', 1), [true]);
});

test('a new window starts fresh', { skip }, async t => {
  const kv = await memoryKv(t);
  const clock = { t: 0 };
  const l = kvLimiter(kv, 'order', { limit: 1, period: 60, now: () => clock.t });
  assert.deepEqual(await hits(l, 'ip', 2), [true, false]);
  clock.t = 59_999;
  assert.deepEqual(await hits(l, 'ip', 1), [false]);
  clock.t = 60_000;
  assert.deepEqual(await hits(l, 'ip', 1), [true]);
});

test('concurrent hits never pass the limit and refused hits write nothing', { skip }, async t => {
  const kv = await memoryKv(t);
  const l = kvLimiter(kv, 'order', { limit: 5, period: 60, now: () => 0 });
  const results = await Promise.all(Array.from({ length: 8 }, () => l.limit({ key: 'ip' })));
  assert.equal(results.filter(r => r.success).length, 5);
  assert.equal((await kv.get(['rl', 'order', 'ip', 0])).value, 5);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test tests/limiter.test.mjs 2>&1 | grep -E "ERR_MODULE_NOT_FOUND|# fail"`
Expected: a module-not-found error for `server/lib/limiter.js`.

- [ ] **Step 3: Implement `server/lib/limiter.js`**

```js
// Fixed-window rate limiter in Deno KV with the interface of Cloudflare's rate limit binding: limit({ key }) → { success }.
// Refused hits write nothing. Fails open after repeated write clashes, like Cloudflare's limiter.
const ROUNDS = 10;

export function kvLimiter(kv, name, { limit, period, now = Date.now }) {
  const ms = period * 1000;
  return {
    async limit({ key }) {
      const k = ['rl', name, String(key), Math.floor(now() / ms)];
      for (let round = 0; round < ROUNDS; round++) {
        const entry = await kv.get(k);
        const count = (entry.value ?? 0) + 1;
        if (count > limit) return { success: false };
        if ((await kv.atomic().check(entry).set(k, count, { expireIn: 2 * ms }).commit()).ok) return { success: true };
      }
      return { success: true };
    },
  };
}
```

- [ ] **Step 4: Run the tests**

Run: `node --test tests/limiter.test.mjs 2>&1 | grep -E "^# (tests|pass|fail|skipped)"`
Expected: `# tests 3`, `# pass 3`, `# fail 0`, `# skipped 0`

Run: `node --test 2>&1 | grep -E "^# (tests|pass|fail)"`
Expected: `# tests 181`, `# fail 0`

- [ ] **Step 5: Commit**

```bash
git add server/lib/limiter.js tests/limiter.test.mjs
git commit -m "Add a Deno KV rate limiter with the Cloudflare limiter interface

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Admin sales endpoint

**Files:**
- Create: `server/routes/admin.js`
- Modify: `server/index.js` (`ROUTES`, imports)
- Modify: `server/lib/http.js` (`MESSAGES`)
- Test: `tests/admin.test.mjs`

**Interfaces:**
- Consumes: `env.ORDERS.getEntry/commit` (Task 3 contract), `SALES_KEY` from `server/lib/sales.js`, `isSale` from `data/catalog.js`, and `json`, `fail`, `readJson` from `server/lib/http.js`.
- Produces HTTP:
  - `GET /api/admin/sales` → `200 { sales: Sale[], version: string|null }`
  - `PUT /api/admin/sales` with body `{ sales: Sale[], version: string|null }` → `200 { sales, version }`, `400 invalid-sales`, `409 sales-changed`
  - Both routes need `Authorization: Bearer <ADMIN_TOKEN>`, else `401 unauthorized`. Both answer `404 not-found` when `env.ADMIN_TOKEN` is unset or empty. All responses carry `Cache-Control: no-store`.
- Exports: `getSalesRoute(req, c)`, `putSalesRoute(req, c)`.

- [ ] **Step 1: Write the failing tests**

Create `tests/admin.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { call, makeEnv } from './helpers/fake-env.mjs';
import { NOW } from './helpers/fixture.mjs';
import { SALES_KEY } from '../server/lib/sales.js';

const TOKEN = 'admin-test-token';
const iso = ms => new Date(ms).toISOString();
const sale = (over = {}) => ({ id: 's1', percent: 20, eras: ['alpha'], label: null, startsAt: iso(NOW - 3_600_000), endsAt: iso(NOW + 86_400_000), ...over });
const auth = (token = TOKEN) => ({ Authorization: `Bearer ${token}` });
const getSales = (env, headers = auth()) => call('GET', '/api/admin/sales', { env, headers });
const putSales = (env, body, headers = auth()) => call('PUT', '/api/admin/sales', { env, headers, body });

test('the admin routes do not exist without ADMIN_TOKEN, even with a token header', async () => {
  for (const env of [makeEnv(), makeEnv({ ADMIN_TOKEN: '' })]) {
    assert.equal((await getSales(env)).status, 404);
    assert.equal((await putSales(env, { sales: [], version: null })).status, 404);
  }
});

test('a missing, empty, wrong-case or wrong token is 401', async () => {
  const env = makeEnv({ ADMIN_TOKEN: TOKEN });
  for (const headers of [{}, { Authorization: 'Bearer ' }, { Authorization: `bearer ${TOKEN}` }, auth(`${TOKEN}x`), auth('admin-test-tokem'), { Authorization: TOKEN }]) {
    const r = await getSales(env, headers);
    assert.equal(r.status, 401, JSON.stringify(headers));
    assert.equal(r.json.error.code, 'unauthorized');
  }
  assert.equal((await getSales(env)).status, 200);
});

test('GET returns an empty list and a null version when nothing is stored', async () => {
  const r = await getSales(makeEnv({ ADMIN_TOKEN: TOKEN }));
  assert.deepEqual(r.json, { sales: [], version: null });
  assert.equal(r.res.headers.get('cache-control'), 'no-store');
});

test('PUT saves a valid list that GET then returns with its version', async () => {
  const env = makeEnv({ ADMIN_TOKEN: TOKEN });
  const put = await putSales(env, { sales: [sale()], version: null });
  assert.equal(put.status, 200);
  assert.deepEqual(put.json.sales, [sale()]);
  assert.deepEqual(JSON.parse(env.ORDERS.store.get(SALES_KEY).value), [sale()]);
  const got = await getSales(env);
  assert.deepEqual(got.json.sales, [sale()]);
  assert.equal(typeof got.json.version, 'string');
});

test('PUT with a stale version is 409 and changes nothing', async () => {
  const env = makeEnv({ ADMIN_TOKEN: TOKEN });
  await putSales(env, { sales: [sale()], version: null });
  const stale = await putSales(env, { sales: [sale({ id: 's2' })], version: null });
  assert.equal(stale.status, 409);
  assert.equal(stale.json.error.code, 'sales-changed');
  assert.deepEqual(JSON.parse(env.ORDERS.store.get(SALES_KEY).value), [sale()]);
});

test('PUT refuses lists that are not valid sales', async () => {
  const env = makeEnv({ ADMIN_TOKEN: TOKEN });
  for (const body of [{ sales: [sale({ percent: 0 })], version: null }, { sales: 'nope', version: null }, { sales: Array.from({ length: 51 }, (_, i) => sale({ id: `s${i}` })), version: null }, { sales: [], version: 5 }, { version: null }]) {
    const r = await putSales(env, body);
    assert.equal(r.status, 400, JSON.stringify(body).slice(0, 80));
    assert.equal(r.json.error.code, 'invalid-sales');
  }
  assert.equal(env.ORDERS.store.has(SALES_KEY), false);
});

test('a saved sale reprices the store on the next request', async () => {
  const env = makeEnv({ ADMIN_TOKEN: TOKEN });
  await putSales(env, { sales: [sale()], version: null });
  const era = await call('GET', '/api/eras/alpha', { env });
  assert.deepEqual(era.json.products.map(p => [p.id, p.priceCents]), [['alpha-tee', 2799], ['alpha-hood', 3679]]);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test tests/admin.test.mjs 2>&1 | grep -E "^not ok|# fail"`
Expected: every test fails (the routes don't exist yet; `GET` returns 404 and `PUT` returns 404).

- [ ] **Step 3: Add the error messages**

In `server/lib/http.js`, add these entries at the end of `MESSAGES`, after `'paypal-error'`:

```js
  'unauthorized': 'That admin token is missing or wrong.',
  'invalid-sales': 'That sales list is not valid.',
  'sales-changed': 'Sales changed since you read them. Read them again, then retry.',
```

- [ ] **Step 4: Implement `server/routes/admin.js`**

```js
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
  return json({ sales, version: (await c.env.ORDERS.getEntry(SALES_KEY)).version }, 200, noStore);
}
```

- [ ] **Step 5: Route them**

In `server/index.js`, add the import next to the other route imports:

```js
import { getSalesRoute, putSalesRoute } from './routes/admin.js';
```

and add these two entries at the end of `ROUTES`, after the newsletter routes:

```js
  ['GET', /^\/api\/admin\/sales$/, getSalesRoute],
  ['PUT', /^\/api\/admin\/sales$/, putSalesRoute],
```

- [ ] **Step 6: Run the tests**

Run: `node --test tests/admin.test.mjs 2>&1 | grep -E "^# (tests|pass|fail)"`
Expected: `# tests 7`, `# pass 7`, `# fail 0`

Run: `node --test 2>&1 | grep -E "^# (tests|pass|fail)"`
Expected: `# tests 188`, `# fail 0`

- [ ] **Step 7: Commit**

```bash
git add server tests/admin.test.mjs
git commit -m "Add token-protected admin endpoint for sales with compare-and-set

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Static site server

**Files:**
- Create: `server/static.js`
- Modify: `403.html`, `404.html`, `500.html`, `502.html`, `503.html`, `504.html` (line 7, `<base>`)
- Test: `tests/static.test.mjs`

**Interfaces:**
- Consumes: `createLogger` from `server/lib/log.js`.
- Produces:
  - `serveStatic(req, { env, readFile }) → Promise<Response>`. `readFile(relativePath)` returns `Uint8Array` bytes and throws for a missing file (Deno `NotFound`, Node `ENOENT`). `relativePath` has no leading slash, e.g. `assets/css/index.css`.
  - `export const ERROR_CODES = [403, 404, 500, 502, 503, 504]`

- [ ] **Step 1: Write the failing tests**

Create `tests/static.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { serveStatic, ERROR_CODES } from '../server/static.js';

const FILES = {
  'index.html': 'home', 'eras.html': 'eras', '404.html': 'not found', '500.html': 'broken', '503.html': 'down',
  'assets/css/index.css': 'body{}', 'assets/js/config.js': 'FROM DISK', 'assets/fonts/CruJones.ttf': 'font',
  'data/site.json': '{}', 'data/eras/core/img/core-tee-black-1.jpg': 'jpg', 'assets/.hidden': 'x',
  'README.md': 'readme', 'server/index.js': 'code', '.env': 'ADMIN_TOKEN=x', 'package.json': '{}',
};
const readFile = async path => {
  if (path === 'assets/explode.css') throw Object.assign(new Error('disk on fire'), { code: 'EIO' });
  if (!(path in FILES)) throw Object.assign(new Error(`missing ${path}`), { code: 'ENOENT' });
  return new TextEncoder().encode(FILES[path]);
};
const get = (path, { method = 'GET', env = {} } = {}) => serveStatic(new Request(`https://shop.test${path}`, { method }), { env, readFile });

test('/ serves index.html as uncached HTML', async () => {
  const r = await get('/');
  assert.equal(r.status, 200);
  assert.equal(await r.text(), 'home');
  assert.equal(r.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.equal(r.headers.get('cache-control'), 'no-cache');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
});

test('root pages, assets and data are served with their types', async () => {
  for (const [path, type, cache] of [
    ['/eras.html', 'text/html; charset=utf-8', 'no-cache'],
    ['/assets/css/index.css', 'text/css; charset=utf-8', 'public, max-age=3600'],
    ['/assets/fonts/CruJones.ttf', 'font/ttf', 'public, max-age=3600'],
    ['/data/site.json', 'application/json; charset=utf-8', 'public, max-age=3600'],
    ['/data/eras/core/img/core-tee-black-1.jpg', 'image/jpeg', 'public, max-age=3600'],
  ]) {
    const r = await get(path);
    assert.equal(r.status, 200, path);
    assert.equal(r.headers.get('content-type'), type, path);
    assert.equal(r.headers.get('cache-control'), cache, path);
  }
});

test('nothing outside the allowlist is served, however the path is written', async () => {
  for (const path of ['/README.md', '/server/index.js', '/.env', '/package.json', '/assets/.hidden', '/assets/%2e%2e%2f.env',
    '/assets/..%5c.env', '/data/%00x', '/assets/', '/assets', '/nope.html', '/INDEX.HTML', '/assets//css/index.css', '/%E0%A4%A']) {
    const r = await get(path);
    assert.equal(r.status, 404, path);
    assert.equal(await r.text(), 'not found', path);
  }
});

test('config.js is generated from env, never read from disk', async () => {
  const r = await get('/assets/js/config.js', { env: { PAYPAL_CLIENT_ID: 'live-"id' } });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'text/javascript; charset=utf-8');
  assert.equal(await r.text(), `export const API_BASE = '';\nexport const PAYPAL_CLIENT_ID = "live-\\"id";\n`);
  assert.match(await (await get('/assets/js/config.js')).text(), /PAYPAL_CLIENT_ID = "test"/);
});

test('/__error/<code> shows that page only in development', async () => {
  const dev = await get('/__error/503', { env: { ENVIRONMENT: 'development' } });
  assert.equal(dev.status, 503);
  assert.equal(await dev.text(), 'down');
  assert.equal((await get('/__error/503', { env: { ENVIRONMENT: 'production' } })).status, 404);
  assert.equal((await get('/__error/418', { env: { ENVIRONMENT: 'development' } })).status, 404);
});

test('HEAD has headers and no body; other methods are 405', async () => {
  const head = await get('/', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  const post = await get('/', { method: 'POST' });
  assert.equal(post.status, 405);
  assert.equal(post.headers.get('allow'), 'GET, HEAD');
});

test('a disk error other than a missing file is a 500 page', async () => {
  const r = await get('/assets/explode.css');
  assert.equal(r.status, 500);
  assert.equal(await r.text(), 'broken');
});

test('every real error page resolves links from the site root', () => {
  for (const code of ERROR_CODES) assert.match(readFileSync(new URL(`../${code}.html`, import.meta.url), 'utf8'), /<base href="\/">/, `${code}.html`);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test tests/static.test.mjs 2>&1 | grep -E "ERR_MODULE_NOT_FOUND|# fail"`
Expected: a module-not-found error for `server/static.js`.

- [ ] **Step 3: Implement `server/static.js`**

```js
import { createLogger } from './lib/log.js';

// The public site: root .html pages, /assets/ and /data/. Nothing else in the repo (server code, docs, .env,
// package files) is ever served. Missing pages get 404.html with a real 404 status.
export const ERROR_CODES = [403, 404, 500, 502, 503, 504];

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.mp4': 'video/mp4',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
};
const PAGE = /^\/[a-z0-9-]+\.html$/;
const DIRS = ['/assets/', '/data/'];
const MISSING = new Set(['ENOENT', 'EISDIR', 'EACCES', 'EPERM', 'NotFound', 'IsADirectory', 'PermissionDenied']);

const extension = path => /\.[a-z0-9]+$/i.exec(path)?.[0].toLowerCase() ?? '';
const missing = err => MISSING.has(err?.code) || MISSING.has(err?.name);

function allowed(path) {
  if (/\.\.|\\|\0|\/\//.test(path) || path.split('/').some(part => part.startsWith('.'))) return false;
  return PAGE.test(path) || DIRS.some(dir => path.startsWith(dir) && !path.endsWith('/'));
}

// The site's runtime settings. The API is same-origin, so API_BASE is always ''.
const configJs = env => `export const API_BASE = '';\nexport const PAYPAL_CLIENT_ID = ${JSON.stringify(env.PAYPAL_CLIENT_ID ?? 'test')};\n`;

export async function serveStatic(req, { env = {}, readFile }) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } });
  const send = (body, path, status = 200, cache = extension(path) === '.html' ? 'no-cache' : 'public, max-age=3600') =>
    new Response(req.method === 'HEAD' ? null : body, {
      status,
      headers: { 'Content-Type': TYPES[extension(path)] ?? 'application/octet-stream', 'Cache-Control': cache, 'X-Content-Type-Options': 'nosniff' },
    });
  const errorPage = async code => send(await readFile(`${code}.html`), `${code}.html`, code, 'no-store');

  try {
    let path;
    try { path = decodeURIComponent(new URL(req.url).pathname); } catch { return await errorPage(404); }
    if (path === '/') path = '/index.html';
    if (path === '/assets/js/config.js') return send(configJs(env), path, 200, 'no-cache');
    const forced = /^\/__error\/(\d{3})$/.exec(path);
    if (forced && env.ENVIRONMENT === 'development' && ERROR_CODES.includes(Number(forced[1]))) return await errorPage(Number(forced[1]));
    if (allowed(path)) {
      try { return send(await readFile(path.slice(1)), path); }
      catch (err) { if (!missing(err)) throw err; }
    }
    return await errorPage(404);
  } catch (err) {
    createLogger({ route: `${req.method} static` }).error('static.failed', { message: String(err?.message ?? err) });
    try { return await errorPage(500); } catch { return new Response('Server error', { status: 500 }); }
  }
}
```

- [ ] **Step 4: Point the error pages at the site root**

```bash
sed -i 's#<base href="/evincus/">#<base href="/">#' 403.html 404.html 500.html 502.html 503.html 504.html
```

Run: `grep -n "<base" 403.html 404.html 500.html 502.html 503.html 504.html`
Expected: six lines, each `<base href="/">`.

- [ ] **Step 5: Run the tests**

Run: `node --test tests/static.test.mjs 2>&1 | grep -E "^# (tests|pass|fail)"`
Expected: `# tests 8`, `# pass 8`, `# fail 0`

Run: `node --test 2>&1 | grep -E "^# (tests|pass|fail)"`
Expected: `# tests 196`, `# fail 0`

- [ ] **Step 6: Commit**

```bash
git add server/static.js tests/static.test.mjs 403.html 404.html 500.html 502.html 503.html 504.html
git commit -m "Add allowlisted static server and serve error pages from the site root

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Deno entry and local development

**Files:**
- Create: `main.js`, `deno.json`, `.env.example`
- Rewrite: `scripts/error.mjs`
- Delete: `scripts/dev.mjs`
- Modify: `package.json` (`scripts`)
- Modify (local only, gitignored): `.claude/launch.json`

**Interfaces:**
- Consumes: `createApp` (`server/index.js`), `serveStatic` and `ERROR_CODES` (`server/static.js`), `kvStore` (`server/lib/kv-store.js`), `kvLimiter` (`server/lib/limiter.js`), `createLogger` (`server/lib/log.js`).
- Produces: `deno task dev` / `npm run dev` serves the site and API on `http://localhost:8000`. Production `env` carries `ORDERS`, `ORDER_LIMIT` (5/60 s), `BEACON_LIMIT` (10/60 s), and `COMMIT_SHA` (falls back to `DENO_DEPLOYMENT_ID`, then `'dev'`).

- [ ] **Step 1: Write `main.js`**

```js
// Deno Deploy entry: the site and /api/* from one app. Everything Deno-specific lives here;
// server/ stays runtime-neutral so its tests run under Node.
import { createApp } from './server/index.js';
import { serveStatic } from './server/static.js';
import { kvStore } from './server/lib/kv-store.js';
import { kvLimiter } from './server/lib/limiter.js';
import { createLogger } from './server/lib/log.js';

const kv = await Deno.openKv();
const env = {
  ...Deno.env.toObject(),
  COMMIT_SHA: Deno.env.get('COMMIT_SHA') ?? Deno.env.get('DENO_DEPLOYMENT_ID') ?? 'dev',
  ORDERS: kvStore(kv),
  ORDER_LIMIT: kvLimiter(kv, 'order', { limit: 5, period: 60 }),
  BEACON_LIMIT: kvLimiter(kv, 'beacon', { limit: 10, period: 60 }),
};
const app = createApp();
const log = createLogger({ route: 'background' });

// Deno gives background work no lifetime past the response. Failures are logged, and anything that must happen
// (order confirmations) is also queued in KV for the cron to retry.
function context(ip) {
  const pending = [];
  return {
    ip,
    waitUntil: p => { pending.push(Promise.resolve(p).catch(err => log.error('unhandled', { message: String(err?.message ?? err) }))); },
    settle: () => Promise.all(pending),
  };
}

// Registered at top level so Deploy discovers it. Awaiting settle() keeps a run alive until its work is done,
// and Deploy skips a run while the previous one is still going.
Deno.cron('jobs', '*/15 * * * *', async () => {
  const ctx = context();
  await app.scheduled({}, env, ctx);
  await ctx.settle();
});

const readFile = path => Deno.readFile(new URL(path, import.meta.url));

Deno.serve((req, info) => new URL(req.url).pathname.startsWith('/api/')
  ? app.fetch(req, env, context(info.remoteAddr.hostname))
  : serveStatic(req, { env, readFile }));
```

- [ ] **Step 2: Write `deno.json`**

```json
{
  "unstable": ["kv", "cron"],
  "tasks": {
    "dev": "deno run --allow-net --allow-read --allow-env --env-file=.env --watch main.js"
  }
}
```

- [ ] **Step 3: Write `.env.example`**

```
# Copy to .env for npm run dev. .env is gitignored: never commit it.
ENVIRONMENT=development
SITE_URL=http://localhost:8000
API_URL=http://localhost:8000
PAYMENT_MODE=none
SHIPPING_USD=0
DELIVERY_EXCLUDED_COUNTRIES=
OWNER_EMAIL=you@example.com
EMAIL_FROM=Evincus <orders@evincus.shop>
# Blank turns the newsletter off locally.
NEWSLETTER_HOUR=
NEWSLETTER_KEY=local-dev-only
ORDER_HMAC_KEY=local-dev-only
# npm run discount sends this to the server; both read it from here locally.
ADMIN_TOKEN=local-dev-only
# Leave blank to skip real email locally.
RESEND_API_KEY=
```

- [ ] **Step 4: Rewrite `scripts/error.mjs` and delete `scripts/dev.mjs`**

Replace `scripts/error.mjs` with:

```js
// npm run error 404 -> the URL of that error page on the local server (also 403/500/502/503/504).
import { ERROR_CODES } from '../server/static.js';

const code = Number(process.argv[2]);
if (!ERROR_CODES.includes(code)) {
  console.error(`Usage: npm run error <code>   (codes: ${ERROR_CODES.join(', ')})`);
  process.exit(1);
}
console.log(`Error ${code} page: http://localhost:8000/__error/${code}
Start the site first with npm run dev; .env must have ENVIRONMENT=development.`);
```

```bash
git rm scripts/dev.mjs
```

- [ ] **Step 5: Update `package.json` scripts**

Replace the `scripts` block with:

```json
  "scripts": {
    "test": "node --test",
    "dev": "deno task dev",
    "error": "node scripts/error.mjs",
    "new-era": "node scripts/new-era.mjs",
    "discount": "node scripts/discount.mjs"
  },
```

- [ ] **Step 6: Point the preview config at Deno**

Replace `.claude/launch.json` (gitignored, so it is not committed) with:

```json
{
  "version": "0.0.1",
  "configurations": [
    {
      "name": "evincus",
      "runtimeExecutable": "deno",
      "runtimeArgs": ["task", "dev"],
      "port": 8000
    }
  ]
}
```

- [ ] **Step 7: Check that `server/` stays runtime-neutral**

Run: `grep -rnE "Deno\.|from 'node:|Buffer|process\." server`
Expected: no output.

- [ ] **Step 8: Smoke test the real server**

```bash
cp .env.example .env
```

Start the server in a second terminal with `npm run dev`. If it is already running in the preview pane, use that instead. Then run:

```bash
curl -s -o /dev/null -w "%{http_code} %{content_type}\n" http://localhost:8000/
curl -s http://localhost:8000/api/health
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8000/README.md
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8000/__error/503
curl -s http://localhost:8000/assets/js/config.js
curl -s http://localhost:8000/api/eras | head -c 120; echo
curl -s -H "Authorization: Bearer local-dev-only" http://localhost:8000/api/admin/sales
node scripts/error.mjs 503
```

Expected, in order:
- `200 text/html; charset=utf-8`
- JSON with `"ok":true`, `"kv":"ok"`, `"commit":"dev"`
- `404`
- `503`
- `export const API_BASE = '';` followed by `export const PAYPAL_CLIENT_ID = "test";`
- JSON that contains `"eras"` and the live era names (status 200)
- `{"sales":[],"version":null}` on a fresh local store (Deno keeps local KV between restarts; a non-null `version` only means sales were written before)
- `Error 503 page: http://localhost:8000/__error/503`

Open `http://localhost:8000/` in the browser preview. The page must render with styles and catalog, with no console errors and no requests to `localhost:8787`. Stop the server afterwards.

- [ ] **Step 9: Run the whole suite**

Run: `node --test 2>&1 | grep -E "^# (tests|pass|fail)"`
Expected: `# tests 196`, `# fail 0`

- [ ] **Step 10: Commit**

```bash
git add main.js deno.json .env.example scripts/error.mjs package.json
git commit -m "Add Deno entry serving the site and API, with cron and KV bindings

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: `npm run discount` through the admin endpoint

**Files:**
- Modify: `scripts/discount.mjs` (header comment, `USAGE`, `WORDS`, `parseArgs`; replace the `// ---------- KV through wrangler ----------` section and `main`)
- Modify: `tests/sales.test.mjs` (import line 7, the two `parseArgs` tests, remove the `parseStored` test)
- Test: `tests/discount.test.mjs` (new)

**Interfaces:**
- Consumes: `GET/PUT /api/admin/sales` (Task 6), `createApp` and `makeCtx` (for the contract test).
- Produces (exports of `scripts/discount.mjs`):
  - `PROD_URL = 'https://evincus.jojo6550.deno.net'`, `LOCAL_URL = 'http://localhost:8000'`
  - `parseArgs(argv)` → flags `{ local, dryRun, label, starts, url }`. `staging` throws.
  - `apiBase(flags) → string` with no trailing slash
  - `adminToken(env = process.env, readEnvFile?) → string`
  - `readSales(base, token, fetchFn = fetch) → Promise<{ sales, version }>`
  - `writeSales(base, token, sales, version, fetchFn = fetch) → Promise<void>`
  - Unchanged: `SALES_KEY`, `USAGE`, `makeSale`, `addSale`, `endSale`, `describe`
  - Removed: `parseStored`

- [ ] **Step 1: Write the failing tests**

Create `tests/discount.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, makeCtx } from './helpers/fake-env.mjs';
import { FIXTURE, NOW } from './helpers/fixture.mjs';
import { createApp } from '../server/index.js';
import { PROD_URL, LOCAL_URL, apiBase, adminToken, readSales, writeSales } from '../scripts/discount.mjs';

const TOKEN = 'admin-test-token';
const iso = ms => new Date(ms).toISOString();
const sale = (over = {}) => ({ id: 's1', percent: 20, eras: ['alpha'], label: null, startsAt: iso(NOW), endsAt: iso(NOW + 3_600_000), ...over });

// A fetch that hands requests straight to the app, so the script and the route are tested together.
function appFetch(env) {
  const app = createApp({ data: FIXTURE, clock: () => NOW });
  return async (url, init) => {
    const ctx = makeCtx();
    const res = await app.fetch(new Request(url, init), env, ctx);
    await ctx.settle();
    return res;
  };
}

test('apiBase picks production, local, or a given URL without a trailing slash', () => {
  assert.equal(apiBase({ local: false, url: null }), PROD_URL);
  assert.equal(apiBase({ local: true, url: null }), LOCAL_URL);
  assert.equal(apiBase({ local: false, url: 'https://evincus-dev.jojo6550.deno.net/' }), 'https://evincus-dev.jojo6550.deno.net');
});

test('adminToken reads the environment first, then .env', () => {
  assert.equal(adminToken({ ADMIN_TOKEN: 'from-env' }, () => 'ADMIN_TOKEN=from-file'), 'from-env');
  assert.equal(adminToken({}, () => 'X=1\nADMIN_TOKEN="from-file"\n'), 'from-file');
  assert.equal(adminToken({}, () => 'ADMIN_TOKEN=plain\r\nY=2'), 'plain');
  assert.throws(() => adminToken({}, () => { throw new Error('no file'); }), /ADMIN_TOKEN/);
  assert.throws(() => adminToken({}, () => 'ADMIN_TOKEN=\n'), /ADMIN_TOKEN/);
});

test('read and write go through the admin endpoint with the version that was read', async () => {
  const f = appFetch(makeEnv({ ADMIN_TOKEN: TOKEN }));
  const first = await readSales(PROD_URL, TOKEN, f);
  assert.deepEqual(first, { sales: [], version: null });
  await writeSales(PROD_URL, TOKEN, [sale()], first.version, f);
  assert.deepEqual((await readSales(PROD_URL, TOKEN, f)).sales, [sale()]);
});

test('a write after someone else changed the sales is refused with a clear message', async () => {
  const f = appFetch(makeEnv({ ADMIN_TOKEN: TOKEN }));
  const { version } = await readSales(PROD_URL, TOKEN, f);
  await writeSales(PROD_URL, TOKEN, [sale()], version, f);
  await assert.rejects(writeSales(PROD_URL, TOKEN, [sale({ id: 's2' })], version, f), /changed since/);
});

test('a wrong token or a server without ADMIN_TOKEN explains what to fix', async () => {
  await assert.rejects(readSales(PROD_URL, 'wrong', appFetch(makeEnv({ ADMIN_TOKEN: TOKEN }))), /refused the admin token/);
  await assert.rejects(readSales(PROD_URL, TOKEN, appFetch(makeEnv())), /no admin endpoint/);
});

test('an unreachable server says which URL and what to do', async () => {
  const down = async () => { throw new TypeError('fetch failed'); };
  await assert.rejects(readSales(LOCAL_URL, TOKEN, down), /Could not reach http:\/\/localhost:8000/);
});
```

In `tests/sales.test.mjs`, change line 7 to:

```js
import { addSale, endSale, makeSale, parseArgs } from '../scripts/discount.mjs';
```

Replace the test `parseArgs reads a sale, list, end, and flags` with:

```js
test('parseArgs reads a sale, list, end, and flags', () => {
  assert.deepEqual(parseArgs(['catastrophe,core', '3', '20%', '--label', 'Fall', '--url', 'https://preview.test']),
    { cmd: 'start', target: 'catastrophe,core', days: '3', percent: '20%', flags: { local: false, dryRun: false, label: 'Fall', starts: null, url: 'https://preview.test' } });
  assert.equal(parseArgs(['list']).cmd, 'list');
  assert.equal(parseArgs(['end', 'all']).id, 'all');
  assert.equal(parseArgs([]).cmd, 'help');
  assert.throws(() => parseArgs(['core', '3']), /Expected/);
  assert.throws(() => parseArgs(['core', '3', '20', '--nope']), /Unknown option/);
  assert.throws(() => parseArgs(['list', 'url=https://preview.test', 'local']), /not both/);
  assert.throws(() => parseArgs(['list', 'staging']), /url=/);
});
```

Replace the test `parseArgs takes options as plain words too, so npm never swallows them` with:

```js
test('parseArgs takes options as plain words too, so npm never swallows them', () => {
  assert.deepEqual(parseArgs(['catastrophe', '3', '20', 'local', 'dry-run', 'label=Fall sale', 'starts=2026-11-27T00:00:00-05:00']).flags,
    { local: true, dryRun: true, label: 'Fall sale', starts: '2026-11-27T00:00:00-05:00', url: null });
  assert.equal(parseArgs(['list', 'url=https://preview.test']).flags.url, 'https://preview.test');
  assert.equal(parseArgs(['end', 'all', '--local']).flags.local, true);
});
```

Delete the whole test `parseStored reads wrangler output with or without a banner`.

- [ ] **Step 2: Run them to see them fail**

Run: `node --test tests/discount.test.mjs tests/sales.test.mjs 2>&1 | grep -E "does not provide|^not ok|# fail"`
Expected: an import error (`PROD_URL` is not exported) and failing `parseArgs` tests.

- [ ] **Step 3: Update the header, usage and argument parsing in `scripts/discount.mjs`**

Replace lines 1-8 (the comment and imports) with:

```js
// Runs a timed sale on the live store: `npm run discount <eras|all> <days> <percent>`.
// Sales are stored in KV (key config:sales) through the server's /api/admin/sales endpoint and apply on the next
// page load, with no deploy. See `npm run discount help`.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SALE_MAX_PERCENT, isSale, pendingSales } from '../data/catalog.js';

export const PROD_URL = 'https://evincus.jojo6550.deno.net';
export const LOCAL_URL = 'http://localhost:8000';
```

(`SALES_KEY`, `DAY` and `MAX_DAYS` below them stay.)

In `USAGE`, replace the two lines

```
  staging          use the staging API instead of production
  local            use the local wrangler dev store (npm run dev:api)
```

with

```
  local            use the local server (npm run dev)
  url=<base>       use another deployment, e.g. a branch preview URL
```

and append this line after `dry-run          print the change without saving it`:

```
Needs ADMIN_TOKEN (the server's value) in your environment or in .env.
```

Replace the `WORDS` comment, constant and the whole `parseArgs` function with:

```js
// Options also work as plain words (local, dry-run, label=..., starts=..., url=...). npm never sees those,
// unlike --flags, which npm keeps for itself whenever the `--` is missing (Windows PowerShell drops it).
const WORDS = { local: 'local', 'dry-run': 'dryRun' };

export function parseArgs(argv) {
  const flags = { local: false, dryRun: false, label: null, starts: null, url: null };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const bare = a.replace(/^--/, '');
    if (bare === 'staging') throw new Error('staging is gone: each branch has its own preview. Use url=<preview URL> instead.');
    const word = WORDS[bare];
    const kv = /^(?:--)?(label|starts|url)=([\s\S]*)$/.exec(a);
    if (word) flags[word] = true;
    else if (kv) flags[kv[1]] = kv[2];
    else if (a === '--label' || a === '--starts' || a === '--url') {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value.`);
      flags[a.slice(2)] = v;
    } else if (a.startsWith('--')) throw new Error(`Unknown option ${a}.`);
    else rest.push(a);
  }
  if (flags.url && flags.local) throw new Error('Use url= or local, not both.');
  const [cmd, ...args] = rest;
  if (!cmd || cmd === 'help') return { cmd: 'help', flags };
  if (cmd === 'list') return { cmd: 'list', flags };
  if (cmd === 'end') {
    if (args.length !== 1) throw new Error('Say which sale to end: npm run discount end <id|all>');
    return { cmd: 'end', id: args[0], flags };
  }
  if (args.length !== 2) throw new Error(`Expected <eras> <days> <percent>.\n\n${USAGE}`);
  return { cmd: 'start', target: cmd, days: args[0], percent: args[1], flags };
}
```

- [ ] **Step 4: Replace the wrangler section and `main`**

Replace everything from `// ---------- KV through wrangler ----------` to the end of the file with:

```js
// ---------- the admin endpoint ----------

export const apiBase = flags => (flags.local ? LOCAL_URL : flags.url ?? PROD_URL).replace(/\/+$/, '');

// ADMIN_TOKEN from the environment, else from .env in the repo root.
export function adminToken(env = process.env, readEnvFile = () => readFileSync(new URL('../.env', import.meta.url), 'utf8')) {
  if (env.ADMIN_TOKEN) return env.ADMIN_TOKEN;
  let text = '';
  try { text = readEnvFile(); } catch { /* no .env */ }
  const token = /^\s*ADMIN_TOKEN\s*=\s*"?([^"\r\n]*)"?\s*$/m.exec(text)?.[1];
  if (token) return token;
  throw new Error('Set ADMIN_TOKEN (the same value as on the server) in your environment or in .env.');
}

async function request(base, token, init, fetchFn) {
  try {
    return await fetchFn(`${base}/api/admin/sales`, { ...init, headers: { Authorization: `Bearer ${token}`, ...init.headers } });
  } catch (err) {
    throw new Error(`Could not reach ${base} (${err.message}). ${base === LOCAL_URL ? 'Start it with npm run dev.' : 'Check the URL and your connection.'}`);
  }
}

async function problem(res) {
  if (res.status === 401) return 'The API refused the admin token. Check ADMIN_TOKEN matches the server.';
  if (res.status === 404) return 'The API has no admin endpoint. Set ADMIN_TOKEN on the server (Deno Deploy environment variables, or .env for npm run dev).';
  let message = '';
  try { message = (await res.json())?.error?.message ?? ''; } catch { /* not JSON */ }
  return `The API answered ${res.status}${message ? `: ${message}` : ''}.`;
}

export async function readSales(base, token, fetchFn = fetch) {
  const res = await request(base, token, { method: 'GET' }, fetchFn);
  if (!res.ok) throw new Error(await problem(res));
  const { sales, version } = await res.json();
  if (!Array.isArray(sales)) throw new Error('The API returned sales that are not a list.');
  return { sales, version };
}

export async function writeSales(base, token, sales, version, fetchFn = fetch) {
  const res = await request(base, token, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sales, version }) }, fetchFn);
  if (res.status === 409) throw new Error('Sales changed since this command read them. Run npm run discount list, then try again.');
  if (!res.ok) throw new Error(await problem(res));
}

async function main(argv) {
  const opts = parseArgs(argv);
  if (opts.cmd === 'help') return console.log(USAGE);
  const { flags } = opts;
  const base = apiBase(flags);
  const where = flags.local ? 'local' : flags.url ? base : 'PRODUCTION';
  const token = adminToken();
  const now = new Date();
  const { sales: list, version } = await readSales(base, token);

  if (opts.cmd === 'list') {
    const pending = pendingSales(list, now);
    return console.log(pending.length ? `Sales on ${where}:\n${pending.map(s => describe(s, now)).join('\n')}` : `No running or scheduled sales on ${where}.`);
  }

  let next, done;
  if (opts.cmd === 'end') {
    next = endSale(list, opts.id, now);
    done = opts.id === 'all' ? `Ended every sale on ${where}.` : `Ended sale ${opts.id} on ${where}.`;
  } else {
    const { FOLDERS } = await import('../data/eras/index.js');
    const sale = makeSale({ ...opts, label: flags.label, starts: flags.starts }, FOLDERS, now);
    next = addSale(list, sale, now);
    done = `Sale saved on ${where}:\n${describe(sale, now)}`;
  }

  if (flags.dryRun) return console.log(`Dry run, nothing saved. ${where} would have:\n${JSON.stringify(next, null, 2)}`);
  await writeSales(base, token, next, version);
  console.log(`${done}\nShoppers see the change on their next page load.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(err => {
    console.error(err.message);
    process.exit(1);
  });
}
```

- [ ] **Step 5: Run the tests**

Run: `node --test tests/discount.test.mjs tests/sales.test.mjs 2>&1 | grep -E "^# (pass|fail)"`
Expected: `# fail 0`

Run: `node --test 2>&1 | grep -E "^# (tests|pass|fail)"`
Expected: `# tests 201`, `# fail 0` (196 − 1 `parseStored` + 6 new)

Run: `grep -n "wrangler\|execFileSync\|tmpdir" scripts/discount.mjs`
Expected: no output.

- [ ] **Step 6: Smoke test against the local server**

With `npm run dev` running and `.env` from Task 8:

```bash
npm run discount list local
npm run discount catastrophe 1 20 local
npm run discount list local
npm run discount end all local
```

Expected, in order: `No running or scheduled sales on local.`; `Sale saved on local:` with a 20% line; a `LIVE` sale; `Ended every sale on local.`

- [ ] **Step 7: Commit**

```bash
git add scripts/discount.mjs tests/discount.test.mjs tests/sales.test.mjs
git commit -m "Run npm run discount through the admin endpoint instead of wrangler

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Remove Cloudflare and Pages; CI and docs

**Files:**
- Delete: `worker/` (`wrangler.toml` and the untracked `.wrangler/`, `migrations/`), `assets/js/config.example.js`, `.github/workflows/deploy.yml`
- Create: `.github/workflows/ci.yml`
- Modify: `package.json`, `package-lock.json` (drop `wrangler`), `.gitignore`
- Modify comments: `assets/js/env.js:1-3`, `server/lib/log.js:1`, `server/lib/catalog.js:1`, `server/lib/sales.js:1-5,13`, `server/routes/capture.js:60`, `tests/data.test.mjs:38`
- Rewrite: `README.md`

**Interfaces:**
- Consumes: everything above.
- Produces: a repo with no Cloudflare or Pages references outside `docs/superpowers/` history.

- [ ] **Step 1: Delete Cloudflare and Pages files**

```bash
git rm worker/wrangler.toml assets/js/config.example.js .github/workflows/deploy.yml
rm -rf worker
npm uninstall wrangler
```

Expected: `package.json` `devDependencies` holds only `@deno/kv`.

- [ ] **Step 2: Add CI**

Create `.github/workflows/ci.yml`:

```yaml
# Tests only. Deno Deploy builds and deploys the app itself on every push.
name: CI

on:
  push:
  pull_request:

permissions:
  contents: read

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0
      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4.4.0
        with:
          node-version: 22
      - run: npm ci
      - run: node --test
```

- [ ] **Step 3: Clean `.gitignore`**

Replace `.gitignore` with:

```
# Local copy of the old CI-written config; the server generates config.js now.
assets/js/config.js
node_modules/
.remember/
.claude/
.env
```

- [ ] **Step 4: Update comments that name the old platform**

`assets/js/env.js`, replace lines 1-3 with:

```js
// Public site settings. The server generates config.js from its environment (server/static.js); when the site is
// opened without that server (a plain file server), the import fails and these defaults apply instead of
// stopping every module that imports this one.
```

`server/lib/log.js` line 1:

```js
// One JSON object per line, readable in the Deno Deploy logs. PII never reaches a log.
```

`server/lib/catalog.js` line 1: replace `bundled into the Worker at deploy` with `bundled into the server at deploy`.

`server/lib/sales.js`, replace lines 1-5 with:

```js
// Sales live in KV under one key, written by `npm run discount` through /api/admin/sales. KV reads are strongly
// consistent, so a new or ended-early sale applies on the next request; scheduled start and end times are exact
// because they're checked against the request clock.
export const SALES_KEY = 'config:sales';
```

and in `loadSales` replace `await env.ORDERS.get(SALES_KEY, { type: 'text', cacheTtl: SALES_CACHE_TTL })` with `await env.ORDERS.get(SALES_KEY)`.

`server/routes/capture.js` line 60: replace `(a success the Worker missed)` with `(a success the server missed)`.

`tests/data.test.mjs` line 38: replace `// exact case: Pages is case-sensitive` with `// exact case: the server's file system is case-sensitive`.

`tests/helpers/fake-env.mjs`: replace `// One request through the Worker, with waitUntil work finished before returning.` with `// One request through the app, with waitUntil work finished before returning.`

- [ ] **Step 5: Rewrite `README.md`**

Replace the whole file with:

````markdown
# Evincus storefront

One Deno Deploy app serves the static store and its API (`/api/*`) from the same origin. Vanilla ES modules, with
no build step. Checkout places orders directly. **No payment service is used and no payment is collected.**

## Layout

- `index.html`: the whole site, a single dark "Catastrophe" landing page with an era filter, product view dialog,
  bag drawer and in-drawer delivery / pickup checkout.
- `assets/js`: `index.js`, `store.js`, `api.js`, `cart.js`, `quote.js`, `bag.js`, `product-view.js`, `checkout.js`.
  Styles are in `assets/css/index.css`.
- `data/eras/<slug>/`: one folder per era. `era.js` holds the era and its products; `img/` holds that era's photos.
  `data/eras/index.js` sets the order (newest first). `data/site.json` holds site copy.
- `assets/img/`: every photo that doesn't belong to an era (logo, favicon, `site/` lookbook and banners).
- `data/catalog.js`: catalog rules shared by the site and the API (era status, what's visible, what's buyable).
- `main.js`: the Deno entry (KV, cron, `Deno.serve`). `server/`: the API router (`index.js`), `routes`, `lib`,
  `emails`, and the static file server (`static.js`). Only `main.js` uses Deno APIs; `server/` also runs under Node
  for the tests.
- `policies.html`: customer-facing privacy, shipping, refund, terms and FAQ content,
  linked from the store, eras page and checkout. Refund requests have a 24-hour
  window from purchase. `docs/policies/original-evincus-shop.md` preserves the
  recovered homepage source and records the adaptation decisions.

## Run locally

Needs Deno 2.4 or later for the app and Node 22 for the tests and scripts.

```bash
npm install                 # test dependencies
cp .env.example .env        # local settings; .env is never committed
npm run dev                 # site and API on http://localhost:8000/
```

Local KV is separate from production, so test orders, subscribers and sales never touch the live store.
`ENVIRONMENT=development` in `.env` lets other localhost origins through CORS and turns on the error page preview:
`npm run error 503` prints its URL.

## Catalog changes

Each era is a folder in `data/eras/`. Image fields in `era.js` are bare filenames from that era's `img/` folder,
lowercase-kebab (`core-tee-black-1.jpg`), max 500 KB each.

| Task | How |
| --- | --- |
| Add an era | `npm run new-era -- <slug> "<Name>"`, add photos to its `img/`, fill in `era.js`, remove every `TODO` |
| Schedule a drop | Set `dropsAt` (ISO with offset, e.g. `2026-11-20T18:00:00-05:00`). Until then the API shows only a teaser |
| Retire an era | Set `endsAt`. Its products stay visible but can't be bought, and old links keep working |
| Delete an era | Delete its folder and its two lines in `data/eras/index.js` |
| Add, edit or remove a product | Edit that era's `products` array and add or remove its photos |
| Move a product to another era | Move its object and its photos to the other folder |
| Sold out | `soldOut: true` for a whole product, or `soldOutVariants: ['Black\|XL']` for one colour and size |
| Replace a stand-in photo | Overwrite the file in `img/` with the same name |

Then `npm test` and push to `main`. Tests check folder names, photos and data before anything deploys.

### Sales

Sales change live prices with no deploy. They're stored in KV (key `config:sales`), written through the
token-protected `/api/admin/sales` endpoint, show a countdown banner on the site, and apply on the next page load.
Start and end times are exact.

| Task | How |
| --- | --- |
| Discount one era | `npm run discount catastrophe 3 20` (3 days, 20% off) |
| Discount a group of eras | `npm run discount catastrophe,core 7 15 label="Fall sale"` |
| Discount everything | `npm run discount all 2 30` |
| Schedule a sale | add `starts=2026-11-27T00:00:00-05:00` |
| See sales | `npm run discount list` |
| End a sale early | `npm run discount end <id>` or `end all` |

Add `local` for `npm run dev`, `url=<deployment URL>` for a branch preview, `dry-run` to preview (plain words, no
dashes: npm keeps `--flags` for itself in PowerShell). The command needs `ADMIN_TOKEN`, the same value as the
server's, in your environment or `.env`. Overlapping sales don't stack: each product gets its era's deepest one. A
PayPal order approved in the last 15 minutes of a sale still captures at the sale price.
Everything in `data/` is served with the site, so an era's folder (`era.js`, photos) can be fetched from the live site
once it's pushed, even with a private repo. The API keeps an upcoming era unbuyable, but it isn't secret. To keep a drop
secret, push its folder on drop day.

### Newsletter

The footer form signs people up (double opt-in: they get a confirm email first). Subscribers are stored in KV as
`sub:<id>`. Every day after `NEWSLETTER_HOUR` (Jamaica time) the cron sends a "What's new" email to every confirmed
subscriber with whatever changed since the last one: drops that went live, sales that started, drops in the next
48 hours, and sales ending in the next 24 hours. Nothing new means no email.

| Setting | Where |
| --- | --- |
| Send hour, or off | `NEWSLETTER_HOUR` (`10` = 10:00, blank = off) |
| Link signing key | `NEWSLETTER_KEY` secret (falls back to `ORDER_HMAC_KEY`) |
| Links and images | `SITE_URL` (the public site) |
| One-click unsubscribe in Gmail/Apple Mail | `API_URL` (the public site too: the API is same-origin) |
| Postal address in the footer (required for marketing email in many countries) | `POSTAL_ADDRESS` |

Emails go through Resend (`RESEND_API_KEY`, `EMAIL_FROM`) in batches of 100. Each batch has a fixed idempotency key,
so cron retries never send anyone the same issue twice.


## Tests

```bash
npm install
node --test
```

The KV adapter and rate limiter tests use real in-memory Deno KV from the `@deno/kv` package.

## Deploy

Deno Deploy builds and deploys `main` on every push (app `evincus`, `https://evincus.jojo6550.deno.net`). Every other
branch gets its own preview timeline with its own KV database and cron. GitHub Actions only runs the tests.

### First deploy checklist (Deno Deploy console)

1. App `evincus`, Edit app config: runtime **Dynamic**, entrypoint `main.js`, install and build commands empty.
2. Databases, Provision Database, **Deno KV**, then Assign it to `evincus` (status: Connected).
3. Environment variables, **Production** context:

   | Variable | Value |
   | --- | --- |
   | `ENVIRONMENT` | `production` |
   | `PAYMENT_MODE` | `none` |
   | `SHIPPING_USD` | flat delivery charge, e.g. `0` |
   | `DELIVERY_EXCLUDED_COUNTRIES` | comma-separated ISO codes, or blank |
   | `OWNER_EMAIL` | where order summaries and alerts go |
   | `EMAIL_FROM` | `Evincus <orders@evincus.shop>` |
   | `ALLOWED_ORIGINS` | other sites allowed to call the API, e.g. `https://evincus.shop,https://www.evincus.shop` |
   | `NEWSLETTER_HOUR` | `10` |
   | `SITE_URL`, `API_URL` | `https://evincus.jojo6550.deno.net` until the custom domain is attached |
   | `POSTAL_ADDRESS` | printed in newsletter footers |
   | Secrets: `RESEND_API_KEY`, `ORDER_HMAC_KEY`, `NEWSLETTER_KEY`, `ADMIN_TOKEN` | long random values. `ADMIN_TOKEN` also goes in your local `.env` for `npm run discount` |

4. Environment variables, **Development** context (branches and previews): `ENVIRONMENT=staging`,
   `NEWSLETTER_HOUR` blank, `OWNER_EMAIL` set to a test inbox, and test values for the secrets. Branch timelines run
   the cron too, so this keeps previews from emailing subscribers or the owner.
5. Verify the sending domain in Resend.
6. Push a branch and place a delivery and a pickup test order on its preview URL.
7. Merge to `main`, then open `/api/health`: it must show `"ok":true` and `"kv":"ok"`.
8. GitHub, Settings, Pages: turn Pages off. The site is no longer served from there.
9. Custom domain: add `evincus.shop` in the app's settings, then set `SITE_URL`, `API_URL` and `ALLOWED_ORIGINS` to it.
10. Keep `PAYMENT_MODE=none`.

## Orders and fulfillment

`POST /api/orders` accepts `checkoutToken` (a UUID), `items`, `customer` (`name`, `email`, `phone`),
`fulfillment`, optional `notes`, and `expectedTotalCents`. The server checks catalog prices, availability,
variants and quantities; mismatched totals require reviewing the bag. Orders are `PLACED`, with
`paymentStatus: NOT_COLLECTED`. `/api/orders/capture` is disabled. No PayPal SDK loads in checkout.

Delivery uses an ISO country dropdown including the USA and Canada. Set `DELIVERY_EXCLUDED_COUNTRIES` to a
comma-separated list of ISO codes when exclusions are known. The current list allows all ISO countries;
carrier restrictions must be configured before launch. Delivery uses the existing flat `SHIPPING_USD` setting
(currently zero); set the confirmed delivery charge before launch. Pickup is free.

`data/fulfillment.js` holds the two pickup locations: Trendy Hats and Vince's store, both in Mandeville,
Manchester, Jamaica. Their addresses are intentionally empty until confirmed. Fill each `address` there;
checkout and confirmations use the same settings. Customers are contacted when pickup is ready.

Each checkout token maps to one order, kept for two years. The order, its Jamaica-day index, its confirmation retry
job and the token's fingerprint are written in one Deno KV atomic commit that only succeeds if the token is new. The
same token and payload return the same order, even if catalog availability changes after placement; different
payloads using the same token are refused. A failed write saves nothing and is safe to retry. The browser keeps an
uncertain submission in session storage and retries it without creating a new order. Only ordered quantities are
removed from the bag.

Customers receive a Resend confirmation after placement. The owner receives a daily summary of the previous
Jamaica calendar day's orders at **08:00 America/Jamaica (13:00 UTC)**, including contact details, line items,
delivery addresses or pickup selections, notes and order totals. Empty days also send a summary. This is order
value, not collected revenue. Summaries split into parts of 20 orders. The 15-minute cron queues summaries
after 08:00 and retries failed deliveries with stable Resend idempotency keys and saved email bodies.
Completed summary markers prevent subsequent sends. A saved cursor catches up after missed cron days.
Customer confirmations use the existing bounded backoff.

Configure `OWNER_EMAIL`, `EMAIL_FROM` and the `RESEND_API_KEY` secret, and verify the sending domain in Resend
before deployment. Use a separate test recipient for previews so test orders do not enter the production mailbox.
No real email delivery is verified by the automated tests.

Legacy PayPal code remains available only behind explicit `PAYMENT_MODE = "paypal"` for future development;
enabling it also requires restoring the payment UI and credentials. Do not change that setting for this release.

## Monitoring

- **Logs:** Deno Deploy console, app `evincus`, Logs. Every line is JSON with `event`, `reqId` and `route`.
  Errors shown to shoppers include the request id.
- **Alerts:** emailed to `OWNER_EMAIL` for unsaved paid orders, possible tampering, undelivered receipts,
  PayPal outages (5+ errors in 10 minutes) and unhandled errors. At most one per event type per hour.
- **Uptime (set up once by hand):** create a free UptimeRobot or Better Stack **keyword (GET) monitor** for
  `https://evincus.jojo6550.deno.net/api/health` (or the custom domain) that expects `"ok":true`. Do not use a plain
  HEAD/HTTP monitor: `/api/health` answers GET only and returns 405 to HEAD. Add a second monitor for the homepage.
  Check both every 5 minutes, alerting by email or SMS. This catches the app being down, which it can't report itself.
- **Free tier:** Deno Deploy limits requests, bandwidth and CPU until the organization is verified (banner in the
  console); verifying raises those limits 100x.
````

- [ ] **Step 6: Sweep for leftovers**

Run: `grep -rniE "wrangler|cloudflare|durable object|workers\.dev|github pages|CF-Connecting|dev:api|deploy:api|8787|/evincus/" --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=docs --exclude-dir=.remember --exclude-dir=.claude .`
Expected: no output.

Run: `grep -rn "\bWorker\b" server assets scripts tests README.md`
Expected: no output.

- [ ] **Step 7: Run the whole suite from a clean install**

```bash
rm -rf node_modules && npm ci && node --test 2>&1 | grep -E "^# (tests|pass|fail|skipped)"
```

Expected: `# tests 201`, `# fail 0`, `# skipped 0`

- [ ] **Step 8: Commit**

```bash
git add -A .github .gitignore assets/js/env.js server tests/data.test.mjs tests/helpers/fake-env.mjs package.json package-lock.json README.md
git commit -m "Remove Cloudflare and Pages setup; CI runs tests, README covers Deno Deploy

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Run: `git status --short`
Expected: no output. The tracked `worker/` and `config.example.js` deletions were staged by `git rm` in Step 1.

---

### Task 11: Final verification

**Files:** none changed unless a check fails.

**Interfaces:**
- Consumes: the whole branch.

- [ ] **Step 1: Full suite**

Run: `node --test 2>&1 | grep -E "^# (tests|pass|fail|skipped)"`
Expected: `# tests 201`, `# pass 201`, `# fail 0`, `# skipped 0`

- [ ] **Step 2: Real-Deno type and lint pass on the entry**

Run: `deno check main.js`
Expected: no errors. (Plain JS: `deno check` resolves every import, so a wrong relative path or a missing export fails here.)

- [ ] **Step 3: End-to-end smoke on the local server**

Start `npm run dev`, then place an order exactly as the browser does:

```bash
TOKEN=$(node -e "console.log(crypto.randomUUID())")
curl -s -X POST http://localhost:8000/api/orders -H "Content-Type: application/json" -d "{\"checkoutToken\":\"$TOKEN\",\"items\":[],\"customer\":{\"name\":\"Ann Lee\",\"email\":\"ann@example.com\",\"phone\":\"+1 555 123 4567\"},\"fulfillment\":{\"type\":\"pickup\",\"locationId\":\"evincus-store\"},\"expectedTotalCents\":0}"
```

Expected: a JSON error with code `invalid-cart` or `bag-changed` (an empty bag is refused), and **not** a 500. Then open `http://localhost:8000/` in the browser preview, add an in-stock item to the bag, check out with pickup, and confirm the success screen shows an `EV-...` order reference. Re-submit the same checkout (reload during submit, or replay the request from the network panel): the same reference comes back.

- [ ] **Step 4: Stop the server and confirm a clean tree**

Run: `git status --short`
Expected: no output.

- [ ] **Step 5: Hand off**

Tell the user what they have to do in the Deno Deploy console (README, First deploy checklist, steps 1-4 and 8), and that pushing `main` deploys.
