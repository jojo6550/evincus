# Deno Deploy: site and API in one app — design

Date: 2026-10-08
Status: approved in brainstorming, pending written-spec review

## 1. Goal and constraints

Move Evincus off Cloudflare Workers and GitHub Pages onto one Deno Deploy app (`evincus`, org `jojo6550`, `https://evincus.jojo6550.deno.net`) that serves the static site and `/api/*` from the same origin.

- Nothing was ever deployed to Cloudflare (`wrangler.toml` still has `REPLACE_WITH_` placeholders and the `local-orders` KV id), so there is no data to migrate.
- Payment paths stay idempotent and race-free. Deno KV has atomic compare-and-set, so order submission gets stronger, not weaker.
- The router, routes, libs, emails and the 160 existing tests stay runtime-neutral and keep running under `node --test`.
- Deno Deploy builds `main` from GitHub on push. CI only runs tests.

### Decisions made

| Topic | Decision |
|---|---|
| Hosting | One Deno Deploy app serves the site and the API. GitHub Pages is dropped |
| Cloudflare | Removed fully: `wrangler.toml`, `wrangler` dependency, Durable Object, CF and Pages deploy jobs |
| Folder | `worker/src/` moves to `server/` |
| Storage | A Cloudflare-KV-shaped adapter over Deno KV, so libs keep calling `env.ORDERS.get/put/delete/list` |
| Order dedupe | The `OrderSubmission` Durable Object becomes one Deno KV atomic commit |
| Rate limits | Fixed-window counters in Deno KV, same `.limit({ key })` interface |
| Cron | `Deno.cron` every 15 minutes calls the existing `scheduled()` |
| `npm run discount` | Talks to a token-protected `/api/admin/sales` endpoint instead of wrangler |
| Public config | The server generates `/assets/js/config.js` from env; the file on disk is never served |
| Tests | Still `node --test`. Adapter tests run against real in-memory Deno KV through the `@deno/kv` npm package |

### Out of scope

Custom domain wiring (`evincus.shop`), Postgres, rewriting libs to native Deno KV keys, changing any business logic, prices, emails or page design.

### Facts relied on (Deno Deploy docs, checked 2026-10-08)

- `Deno.openKv()` with no arguments connects to the database assigned to the app. Deploy keeps a separate database per timeline (production, each git branch, previews). Locally, KV is in memory unless a path is given.
- Deno KV values are capped at 64 KiB; atomic commits at 800 KiB and 1000 mutations.
- `Deno.cron` must be registered at module top level, before `Deno.serve`. Crons run on production and git branch timelines, in UTC. A run is skipped if the previous one is still going.
- KV writes commit in us-east4 with read replicas elsewhere.

## 2. Layout

```
main.js                   Deno entry: KV, env, cron, Deno.serve (the only Deno-specific file)
deno.json                 "unstable": ["kv", "cron"], tasks
server/
  index.js                createApp (router), unchanged apart from ctx.ip and imports
  static.js               static file server (new)
  routes/                 unchanged apart from c.ip; routes/admin.js (new)
  lib/
    kv-store.js           Cloudflare-KV-shaped adapter over Deno KV (new)
    limiter.js            KV rate limiter (new)
    submissions.js        submitOrder() replaces the OrderSubmission class
    ...                   everything else unchanged
  emails/                 unchanged
scripts/
  discount.mjs            HTTP client for /api/admin/sales
  error.mjs               prints the local /__error/<code> URL
.github/workflows/ci.yml  tests only
```

Deleted: `worker/` (after the move), `worker/wrangler.toml`, `worker/migrations/`, `scripts/dev.mjs`, `assets/js/config.example.js`, `.github/workflows/deploy.yml`, the `wrangler` devDependency.

Relative imports change one level: `server/index.js` imports `../data/...`; files in `server/lib|routes|emails` import `../../data/...`. Test imports change from `../worker/src/` to `../server/`.

## 3. Request flow

`main.js`:

```js
const kv = await Deno.openKv();
const env = {
  ...Deno.env.toObject(),
  COMMIT_SHA: Deno.env.get('COMMIT_SHA') ?? Deno.env.get('DENO_DEPLOYMENT_ID') ?? 'dev',
  ORDERS: kvStore(kv),
  ORDER_LIMIT: kvLimiter(kv, 'order', { limit: 5, period: 60 }),
  BEACON_LIMIT: kvLimiter(kv, 'beacon', { limit: 10, period: 60 }),
};
const app = createApp();
Deno.cron('jobs', '*/15 * * * *', () => app.scheduled({}, env, ctx()));
Deno.serve((req, info) => new URL(req.url).pathname.startsWith('/api/')
  ? app.fetch(req, env, ctx(info.remoteAddr.hostname))
  : serveStatic(req, { env, readFile: Deno.readFile }));
```

- `ctx = { waitUntil, ip }`. `waitUntil(p)` attaches a `.catch` that logs and otherwise lets the promise run. Deno has no per-request lifetime guarantee; the order's `email-retry:` job is written before the order is acknowledged, so the cron recovers any email lost to an isolate shutdown (same guarantee as today).
- `createApp` sets `c.ip = ctx.ip ?? 'unknown'`. `routes/checkout.js`, `routes/newsletter.js` and `routes/beacon.js` read `c.ip` instead of `CF-Connecting-IP`.
- `reqId` is `crypto.randomUUID()` (the `cf-ray` lookup goes).
- `scheduled(event, env, ctx)` keeps its signature; `main.js` awaits both its `waitUntil` promises before the cron handler returns, so Deno's no-overlap rule covers the whole run.
- CORS handling stays (harmless same-origin; still useful if another origin calls the API).

## 4. Storage adapter — `server/lib/kv-store.js`

`kvStore(kv, { now = Date.now } = {})` returns:

| Method | Behaviour |
|---|---|
| `get(key, type)` | `type` is `'text'` (default), `'json'`, or `{ type, cacheTtl }` (cacheTtl ignored). Missing or expired → `null` |
| `put(key, value, { expirationTtl, metadata })` | Stores `String(value)` |
| `delete(key)` | Removes the entry and its chunks |
| `list({ prefix, cursor, limit = 1000 })` | `{ keys: [{ name, metadata? }], list_complete, cursor }`, sorted by name, expired entries skipped |
| `getEntry(key)` | `{ value, version }`; `value` is text or `null`, `version` the Deno versionstamp or `null` |
| `commit({ checks = [], puts = [], deletes = [] })` | One atomic commit. `checks: [{ key, version }]` (`null` = must be absent). Returns `true` on success, `false` on a failed check |

Encoding:

- Head entry `['s', key]` → `{ v, m, x, n }`: `v` value text (absent when chunked), `m` metadata, `x` expiry epoch ms or `null`, `n` chunk count (0 when inline).
- Values over 60 000 UTF-8 bytes are split into `['c', key, i]` entries, written in the same atomic commit as the head. Reads fetch chunks with `getMany` in groups of 10 and join them. Overwrites and deletes remove chunks no longer needed.
- `expirationTtl` sets `x = now + ttl*1000` and Deno's `expireIn` on head and chunks (for cleanup). Reads treat `x <= now` as missing, so expiry is exact like Cloudflare's, not best-effort.
- The version reported by `getEntry` and checked by `commit` is the head entry's versionstamp.
- A thrown Deno KV error propagates (callers already handle storage failures).

`tests/helpers/fake-env.mjs`'s `fakeKV` gains `getEntry` and `commit` with a per-key version counter, honouring `failPuts`/`failGets`, so outage tests keep working.

## 5. Order submission — `server/lib/submissions.js`

```js
export async function submitOrder(env, id, fingerprint, record) → { record } | { conflict: true }
```

1. `getEntry('submission:' + id)`.
2. Present: same `fingerprint` → `{ record: saved.record }`; different → `{ conflict: true }`.
3. Absent and `record` is `null` → `{ record: null }` (caller then quotes and builds the record).
4. Absent with a record → `commit` with check `submission:<id>` absent, putting:
   - `submission:<id>` → `{ fingerprint, record }`, TTL `ORDER_TTL`
   - `order:<id>` → record, TTL `ORDER_TTL`
   - `day:<day>:<id>` → `''`, TTL `ORDER_TTL` (same day rule as `saveOrder`, extracted to `dayKey(record)`)
   - `email-retry:<id>` → `{ retries: 0, nextAt: placedAt }`
5. `commit` false (lost a race) → back to step 1. At most 3 rounds, then throw `Order storage unavailable`.

`routes/checkout.js` calls `submitOrder` in place of the Durable Object stub; responses (201, 409 `checkout-conflict`, 409 `bag-changed`) are unchanged. The `indexed` flag disappears because all four writes land together or not at all.

## 6. Rate limiter — `server/lib/limiter.js`

`kvLimiter(kv, name, { limit, period, now = Date.now })` → `{ limit({ key }) → { success } }`.

- Window `w = floor(now / (period*1000))`, key `['rl', name, key, w]`, `expireIn` two periods.
- Read count with versionstamp, `atomic().check(entry).set(key, count + 1)`; retry on a failed check, up to 5 times, then allow (fail open, matching Cloudflare's limiter).
- `success = count + 1 <= limit`.

## 7. Cron

`Deno.cron('jobs', '*/15 * * * *', handler)` registered at top level of `main.js`. The handler runs `app.scheduled` (email retries, daily order digest when payments are off, newsletter). All schedule maths already uses UTC plus the Jamaica offset.

Branch timelines also run crons. Branch deploys must set `NEWSLETTER_HOUR=""` and a non-owner `OWNER_EMAIL` in the Deploy dashboard's non-production env vars so previews never email subscribers or the owner. Each timeline has its own KV, so jobs never cross over.

## 8. Admin sales endpoint — `server/routes/admin.js`

| Route | Behaviour |
|---|---|
| `GET /api/admin/sales` | `200 { sales, version }` from `config:sales` (`sales: []` when missing) |
| `PUT /api/admin/sales` | Body `{ sales, version }`. `sales` must be an array where every item passes `isSale`, at most 50 items, else `400 invalid-sales`. `commit` with check on `version` (`null` = key absent). Success `200 { sales, version: <new> }`; failed check `409 sales-changed` |

- Auth: `Authorization: Bearer <ADMIN_TOKEN>`. Compared in constant time (HMAC both sides with a per-process random key, then compare digests). Missing or wrong token → `401 unauthorized`. If `ADMIN_TOKEN` is not set, both routes answer `404 not-found`, so the endpoint does not exist until configured.
- Responses carry `Cache-Control: no-store`.
- `config:sales` keeps its current JSON-array format, so `loadSales` and pricing are untouched.

## 9. `npm run discount`

Commands, words and validation stay (`<eras> <days> <percent>`, `list`, `end`, `label=`, `starts=`, `dry-run`, `local`). The wrangler code (`target`, `wrangler`, `parseStored`, `read`, `write`) is replaced by:

- Base URL: `local` → `http://localhost:8000`; `url=<base>` → that (branch previews); default → `https://evincus.jojo6550.deno.net`. `staging` becomes an error that says to use `url=`.
- Token: `ADMIN_TOKEN` from the process env, else from `.env` in the repo root.
- `read` → `GET`, `write` → `PUT` with the version from the read. On `409` the script says the sales changed since it read them and asks to run again (no silent retry: the user should see the new list first).
- Output says the change is live immediately (strong reads replace the old one-minute cache note).

## 10. Static site — `server/static.js`

`serveStatic(req, { env, readFile })`:

- `GET` and `HEAD` only (others → `405`).
- Allowed: root files matching `^/[a-z0-9-]+\.html$`, and paths under `/assets/` and `/data/`. `/` → `/index.html`. Paths are decoded, normalized and rejected if they contain `..`, a backslash or a NUL. Anything else, or a missing file → `404.html` with status `404`.
- `/assets/js/config.js` is generated, never read from disk: `export const API_BASE = ''; export const PAYPAL_CLIENT_ID = <JSON of env.PAYPAL_CLIENT_ID ?? 'test'>;`
- `/__error/<code>` (403, 404, 500, 502, 503, 504) serves that page with that status, only when `env.ENVIRONMENT === 'development'`.
- A read error other than not-found → `500.html` with `500`.
- Headers: content type from the table now in `scripts/dev.mjs` (plus `.ttf`, `.woff`, `.mp4`); `X-Content-Type-Options: nosniff`; `.html` → `Cache-Control: no-cache`, everything else → `public, max-age=3600`.
- The six error pages change `<base href="/evincus/">` to `<base href="/">`.

## 11. Local development

- `npm run dev` (and `deno task dev`) → `deno run -A --env-file=.env --watch main.js`. Site and API on `http://localhost:8000/`. `.env` replaces `worker/.dev.vars` and should hold `ENVIRONMENT=development`, `NEWSLETTER_KEY`, `ADMIN_TOKEN`, `SITE_URL=http://localhost:8000`.
- KV is in memory locally (data resets on restart), matching Deploy's local default.
- `npm run error <code>` prints `http://localhost:8000/__error/<code>` and tells the user to start `npm run dev` if it is not running.
- `.claude/launch.json`: one config `evincus` running `deno task dev` on port 8000.
- `package.json` scripts: drop `dev:api` and `deploy:api`; `dev` runs Deno; keep `test`, `new-era`, `discount`, `error`. devDependencies: `@deno/kv` replaces `wrangler`. `engines` keeps Node ≥ 22 for tests and scripts; README states Deno ≥ 2.4 is needed to run the app.

## 12. Deploy setup (done by the user in the Deno Deploy console)

1. App `evincus` → Edit app config: runtime Dynamic, entrypoint `main.js`, install and build commands empty.
2. Databases → Provision Database → Deno KV → Assign to `evincus`.
3. Environment variables, Production context: `ENVIRONMENT=production`, `PAYMENT_MODE=none`, `SHIPPING_USD`, `DELIVERY_EXCLUDED_COUNTRIES`, `OWNER_EMAIL`, `EMAIL_FROM`, `ALLOWED_ORIGINS`, `NEWSLETTER_HOUR=10`, `SITE_URL`, `API_URL`, `POSTAL_ADDRESS`; secrets `RESEND_API_KEY`, `ORDER_HMAC_KEY`, `NEWSLETTER_KEY`, `ADMIN_TOKEN` (and the PayPal ones only if `PAYMENT_MODE=paypal`).
4. Development context: `ENVIRONMENT=staging`, `NEWSLETTER_HOUR=` (blank), a test `OWNER_EMAIL`.
5. Push `main`. Check `GET /api/health` returns `ok: true` with `kv: "ok"`.

`SITE_URL` and `API_URL` become the Deno URL until the custom domain is attached; one-click unsubscribe then works because the API is same-origin.

README's deploy, first-deploy checklist, local dev and newsletter sections are rewritten for this setup; every wrangler and Pages reference goes.

## 13. CI

`.github/workflows/ci.yml` on push and pull request: checkout, Node 22, `npm ci`, `node --test`. Pinned action SHAs as today. No deploy steps.

## 14. Testing

Existing suites keep running unchanged apart from import paths, `c.ip` headers and the fake env. New tests:

| File | Covers |
|---|---|
| `tests/kv-store.test.mjs` | Against `openKv()` from `@deno/kv` (in memory): text/json get, metadata in `list`, prefix + cursor paging, exact TTL expiry with an injected clock, values over 64 KiB round-trip and shrink back, `delete` removes chunks, `commit` check absent / version match / version mismatch |
| `tests/limiter.test.mjs` | Limit reached, window reset, separate keys and names, concurrent hits never exceed the limit |
| `tests/submissions.test.mjs` | First submit writes all four keys; replay returns the saved record; different fingerprint conflicts; two concurrent submits produce one order and one retry job; a failed commit writes nothing |
| `tests/admin.test.mjs` | 404 without `ADMIN_TOKEN`, 401 bad token, GET empty, PUT validates, PUT stale version → 409, PUT then `/api/eras` shows sale prices |
| `tests/static.test.mjs` | `/` → index, allowlist enforced (`/README.md`, `/server/index.js`, `/.env`, traversal → 404), generated `config.js`, `/__error/503` only in development, cache headers, HEAD, 405 |
| `tests/discount.test.mjs` | Base URL and token resolution, GET/PUT with version, 409 message (fetch faked) |

Existing `checkout` and `beacon` tests move from `CF-Connecting-IP` headers to passing `ip` through the test `call()` helper.

Manual smoke before merge: `deno task dev`, then `curl` `/`, `/api/health`, `/api/eras`, a 404 path, `/__error/500`, and `npm run discount list local` / a start and end against the local server.

## 15. Risks

- `@deno/kv` ships native binaries; if it fails to install on a platform, adapter tests are skipped with a clear message rather than failing the suite. CI (Ubuntu) must run them.
- `waitUntil` work can be cut off when an isolate stops; covered by the persisted email-retry job and the 15-minute cron, as today.
- Free-tier Deno Deploy limits (requests, CPU) apply until the org is verified; the shop's traffic fits, but the banner in the console suggests verifying.
