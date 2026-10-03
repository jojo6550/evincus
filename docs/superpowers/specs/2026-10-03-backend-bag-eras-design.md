# Evincus backend: bag, eras, orders — design

Date: 2026-10-03
Status: approved in brainstorming, pending written-spec review

## 1. Goal and constraints

Give the Evincus storefront its first real backend while the site stays static.

- The static site (`index.html`, `pages/`, `assets/`, `data/`) is hosted on **GitHub Pages**.
- GitHub Pages cannot run code, so the API runs on a **Cloudflare Worker** (`api.evincus.shop`).
- The planned move to Cloudflare later must change only where the static files are served from and one config value (`API_BASE`). No API code changes.
- The existing Netlify functions (`netlify/functions/*`) are ported to the Worker and then removed. Their security properties are kept: server-side pricing, HMAC-tagged PayPal orders, re-pricing at capture, captured-amount check.

### Decisions made

| Topic | Decision |
|---|---|
| API host | Cloudflare Worker now; static site on GitHub Pages |
| Bag | Stays in `localStorage`; the Worker gives the authoritative quote. No accounts, no server-side bag |
| Catalog and eras source | JSON files in the repo (`data/eras.json`, `data/products.json`). No admin UI, no database |
| Catalog ownership | The Worker owns the catalog at runtime and serves it; the site renders from the API and falls back to static JSON for browsing only, never for pricing |
| Stock | Manual flags: whole product sold out, or specific colour/size variants sold out. No counts |
| Drops | Era-level `dropsAt` and optional `endsAt`, enforced by the Worker's clock |
| Orders | Logged to Cloudflare KV; receipt and owner emails via Resend |
| Observability | Structured JSON logs in Workers Logs, alert emails to the owner, external uptime monitor |

### Assumptions

- Order records containing PII are kept for 2 years, then expire.
- At current scale the Cloudflare free tier is enough (see section 8).
- If the repo is public, unreleased eras in `data/*.json` are readable on GitHub before the drop. The server blocks browsing and purchase through the site, but cannot hide the file. Keep the repo private, or add an era to the repo only on drop day.

## 2. Architecture

```
GitHub Pages (static)                 Cloudflare Worker (api.evincus.shop)
index.html, pages/*.js, assets/  ──►  GET  /api/eras
  bag in localStorage                  GET  /api/eras/:slug
  fallback: data/*.json (browse only)  GET  /api/products/:id
                                       GET  /api/health
                                       POST /api/bag/quote
                                       POST /api/orders          (PayPal create)
                                       POST /api/orders/capture  (PayPal capture → KV log → Resend email)
                                       POST /api/beacon          (checkout client errors)
                                       cron */15 * * * *         (email retry)
                                         │
                                         ├─ bundled data/eras.json, data/products.json, data/site.json
                                         ├─ KV: ORDERS
                                         ├─ Rate limit binding: BEACON_LIMIT
                                         └─ secrets: PAYPAL_CLIENT_SECRET, ORDER_HMAC_KEY, RESEND_API_KEY
```

### Repo layout

```
data/
  eras.json
  products.json
  site.json              categories, lookbook images
  catalog.js             shared loader + helpers, used by site and Worker
worker/
  wrangler.toml
  src/
    index.js             router, CORS, request logging, top-level error handling, cron handler
    routes/
      eras.js
      products.js
      quote.js
      orders.js          create
      capture.js
      health.js
      beacon.js
    lib/
      catalog.js         era status, visibility, buyable rules (the only place that decides these)
      pricing.js         pure: catalog + items → priced cart / line statuses
      paypal.js          token, create, get, capture
      orders.js          KV order records, day index, email retry keys
      email.js           Resend client
      alerts.js          owner alerts with dedup
      log.js             structured logger with PII redaction
      http.js            JSON responses, error shape, CORS
    emails/
      receipt.js         customer receipt HTML
      owner.js           owner notification HTML
      alert.js           alert HTML
tests/
  catalog.test.mjs
  pricing.test.mjs
  data.test.mjs
  routes.test.mjs
  helpers/fake-env.mjs   in-memory KV, fetch stub, waitUntil collector
.github/workflows/deploy.yml
```

### Boundaries

- `lib/catalog.js` is the only code that decides whether an era or product is visible and buyable. Routes call it; they never compare dates or read sold-out flags themselves.
- `lib/pricing.js` has no I/O. Given the catalog view, a clock and items, it returns a priced cart with per-line statuses.
- The site reads `API_BASE` from `assets/js/config.js`. Moving to same-origin hosting later means setting it to `''`.

### CORS

Allowed origins: `https://<github-user>.github.io`, `https://evincus.shop`, `https://www.evincus.shop`, and `http://localhost:*` in non-production environments. Any other origin gets no CORS headers. Preflight `OPTIONS` is answered by the router.

## 3. Data schema

### `data/eras.json`

An ordered array, newest era first.

```json
[
  {
    "slug": "catastrophe",
    "name": "Catastrophe",
    "tagline": "Peace in chaos",
    "story": "Short paragraph shown on the era page.",
    "hero": "https://…/IMG_0559.jpg",
    "dropsAt": "2026-02-16T17:00:00-05:00",
    "endsAt": null
  },
  {
    "slug": "core",
    "name": "Core",
    "tagline": "…",
    "story": "…",
    "hero": "…",
    "dropsAt": null,
    "endsAt": null
  }
]
```

- `dropsAt: null` means the era has always been live.
- `endsAt` is optional. Once it passes, the era is archived.
- Status is computed from the Worker's clock and never stored:
  - `upcoming` when `dropsAt` is set and now < `dropsAt`
  - `archived` when `endsAt` is set and now ≥ `endsAt`
  - `live` otherwise

### `data/products.json`

```json
[
  {
    "id": "catastrophe-zip-hoodie",
    "era": "catastrophe",
    "name": "Catastrophe Zip Hoodie",
    "category": "outerwear",
    "priceCents": 4599,
    "fabric": "Unisex, 51% polyester / 49% cotton fleece, 360 g/m² (10.6 oz/yd²)",
    "care": "Machine wash at 30°C on a gentle cycle. …",
    "sizes": ["S", "M", "L", "XL", "2XL"],
    "colors": [{ "name": "Black", "hex": "#151515" }, { "name": "Brown", "hex": "#4A3528" }],
    "images": ["https://…"],
    "soldOut": false,
    "soldOutVariants": ["Black|2XL"]
  }
]
```

Changes from `data/products.js`:

- `collection: "Catastrophe"` becomes `era: "catastrophe"`, a slug that must match an era.
- `price: 45.99` becomes `priceCents: 4599`. All money is integer cents end to end, and is formatted only for display and for PayPal.
- Shared strings (`HEAVY_TEE`, `FLEECE`, `TRACK`, `CARE`) are inlined into each product.
- `soldOut` (whole product) and `soldOutVariants` (`"<color>|<size>"`) are new and optional. Defaults: `false` and `[]`.
- Per-colour images keep their current shape: a colour may carry its own `images` array, which `imagesFor()` prefers over the product's `images`; if neither exists, it falls back to the first colour's `images`. The converted JSON must produce identical `imagesFor()` output for every product and colour.
- `CARE_NOTE` remains available from `data/catalog.js`, exported as `data/site.json`'s `careNote`.

### `data/site.json`

`CATEGORIES` and `LOOKBOOK` move here unchanged.

### Visibility and purchase rules

| Era status | Era listed | Products listed / fetchable | Buyable |
|---|---|---|---|
| upcoming | yes, as a teaser (`slug`, `name`, `tagline`, `hero`, `dropsAt`) | no; product URLs return 404 | no |
| live | yes | yes | yes, unless `soldOut` or the variant is in `soldOutVariants` |
| archived | yes | yes | no |

## 4. API contract

All bodies are JSON. Every response has an `x-request-id` header (the `cf-ray` value).

Error shape:

```json
{ "error": { "code": "sold-out", "message": "Shopper-readable sentence.", "requestId": "…", "lines": [] } }
```

`lines` is present only where noted. `message` is safe to show to a shopper as-is: it says what happened and what to do.

Status codes: 400 bad input · 404 unknown or not released · 405 wrong method · 409 catalog state changed · 413 body too large · 422 PayPal declined · 429 rate limited · 502 PayPal or other upstream failure · 500 unhandled.

Request bodies above 16 KB (2 KB for `/api/beacon`) are rejected with 413.

### `GET /api/eras`

```json
{
  "now": "2026-10-03T19:45:00Z",
  "eras": [
    { "slug": "catastrophe", "name": "…", "tagline": "…", "hero": "…",
      "status": "live", "dropsAt": "…", "endsAt": null, "productCount": 4 }
  ]
}
```

Upcoming eras have `productCount: 0` and omit `story`.

### `GET /api/eras/:slug`

The era (including `story` unless upcoming) plus `products`. Each product carries `buyable` (boolean) and `soldOutVariants`. Upcoming: `products: []`. Unknown slug: 404 `unknown-era`.

### `GET /api/products/:id`

The product plus `era: { slug, name, status }` and `buyable`. A product that doesn't exist and a product in an upcoming era both return 404 `unknown-product`, so unreleased products don't leak.

### Caching for GETs

`Cache-Control: public, max-age=N`, where N is 60 seconds or the number of seconds until the next `dropsAt`/`endsAt` boundary, whichever is smaller, with a minimum of 0. A drop goes live within a minute and is never cached past its boundary.

### `POST /api/bag/quote`

Request:

```json
{ "items": [{ "id": "catastrophe-zip-hoodie", "color": "Black", "size": "L", "qty": 1 }] }
```

Response:

```json
{
  "lines": [
    { "key": "catastrophe-zip-hoodie|Black|L", "id": "…", "color": "Black", "size": "L",
      "name": "…", "image": "…", "qty": 1, "unitCents": 4599, "totalCents": 4599, "status": "ok" }
  ],
  "subtotalCents": 4599,
  "shippingCents": 0,
  "totalCents": 4599,
  "checkoutReady": true
}
```

Line statuses:

| Status | Meaning | Counted in totals |
|---|---|---|
| `ok` | buyable | yes |
| `qty-capped` | quantity above 10, clamped to 10 | yes |
| `sold-out` | product or variant sold out | no |
| `not-released` | era is upcoming | no |
| `era-ended` | era is archived | no |
| `unknown-item` | id, colour or size doesn't exist | no |

For `not-released` and `unknown-item`, the line carries no `name`, `image` or price (no leaking).

`checkoutReady` is true only when there is at least one line and every line is `ok` or `qty-capped`.

400 `invalid-cart` is returned only for malformed input: `items` not an array, empty, more than 50 lines, a line missing fields or with a non-integer qty below 1, or duplicate keys.

### `POST /api/orders`

Same request as quote. The Worker runs the quote. If `checkoutReady` is false, or any line is `qty-capped`, it responds 409 `bag-changed` with `lines` from the quote, and the site refreshes the bag. Otherwise it creates the PayPal order as the Netlify function does today: SKU `id|color|size`, integer-cent amounts formatted as USD, HMAC tag in `custom_id`. Response: `{ "id": "<paypal order id>" }`.

### `POST /api/orders/capture`

Request: `{ "orderID": "…" }`. Flow:

1. If KV has `order:<orderID>`, return the stored result: 200 with the same body as the original capture. No PayPal call.
2. Get the order from PayPal. Verify the HMAC tag. Re-price the purchase unit from the catalog (existing `unitMatchesCatalog` behaviour). Check that every line is still buyable at this moment.
   - Tag invalid → 409 `capture-refused`, logged as `capture.refused` with code `tag-mismatch`.
   - Re-price mismatch → 409 `capture-refused`, code `reprice-mismatch`.
   - Line no longer buyable → 409 `bag-changed` with `lines`. PayPal is not charged.
3. Capture with header `PayPal-Request-Id: <orderID>`.
4. Verify the captured amount equals the expected total. On mismatch: 502 `capture-mismatch`, logged with code `amount-mismatch` and alerted.
5. Write the KV record (section 5).
6. Respond `{ "id", "status": "COMPLETED", "totalCents" }`.
7. Send emails in `ctx.waitUntil` after the response.

### `GET /api/health`

```json
{ "ok": true, "catalog": { "eras": 3, "products": 14 }, "kv": "ok", "commit": "39d84b0" }
```

Checks that the catalog parsed and that a KV read succeeds. Never calls PayPal. Returns 503 with `ok: false` if either check fails. `commit` comes from the `COMMIT_SHA` var injected at deploy.

### `POST /api/beacon`

Request: `{ "event": "paypal-sdk-failed", "code": "…", "route": "#/checkout", "reqId": "…" }`.

- `event` must be one of: `paypal-sdk-failed`, `quote-failed`, `order-create-failed`, `capture-failed`, `api-unreachable`.
- `code`, `route` and `reqId` are optional strings of at most 200 characters each.
- Any other field causes a 400.
- Rate limited to 10 requests per minute per IP (Workers Rate Limiting binding); over the limit returns 429.
- Logged as `client.error`. Responds 204.

## 5. Orders and email

### KV records

Key `order:<paypalOrderId>`:

```json
{
  "id": "…", "captureId": "…", "capturedAt": "…", "status": "COMPLETED",
  "lines": [{ "key": "…", "name": "…", "qty": 1, "unitCents": 4599 }],
  "subtotalCents": 4599, "shippingCents": 0, "totalCents": 4599,
  "payer": { "name": "…", "email": "…" },
  "shipTo": { "name": "…", "address": { } },
  "email": { "customer": "sent|pending|failed", "owner": "sent|pending|failed", "attempts": 1 }
}
```

- Index key `day:<YYYY-MM-DD>:<orderId>` with an empty value, so a day's orders can be listed with a prefix scan.
- Both keys get `expirationTtl` of 2 years.
- If the KV write fails after a successful capture, the shopper still gets 200, because the money has moved. An `order.log_failed` event is logged without PII, and an alert email containing the full record goes to the owner.

### Emails

Sent through Resend from `orders@evincus.shop`:

- **Customer receipt:** lines, totals, ship-to, order id, contact address.
- **Owner notification:** the same plus the payer's email; sent to `OWNER_EMAIL`.

Templates are plain HTML string functions in `worker/src/emails/`, with no build step and with all interpolated values escaped. Each send uses `Idempotency-Key: <orderId>-customer` or `<orderId>-owner`.

One-time setup: verify `evincus.shop` in Resend by adding its SPF/DKIM DNS records.

### Email retry

- A failed send sets that recipient's status to `failed` and writes `email-retry:<orderId>` with `{ attempts, nextAt }`.
- A cron trigger runs every 15 minutes and lists `email-retry:` keys. It retries those whose `nextAt` has passed, with backoff of 15 minutes, 30 minutes, 1 hour, 2 hours, then 4 hours.
- On success the retry key is deleted and the record is updated.
- After the 5th failed attempt it logs `email.gave_up`, sends an alert, and deletes the retry key.

### Out of scope

No admin order viewer. The owner uses the PayPal dashboard and the owner emails. A protected `GET /api/admin/orders` can come later.

## 6. Logging and monitoring

### Structured logs

`lib/log.js` writes one JSON object per `console.log` call:

```json
{ "ts": "…", "level": "info", "event": "order.captured", "reqId": "…",
  "route": "POST /api/orders/capture", "status": 200, "ms": 412, "orderId": "…", "code": null }
```

- The router logs one `request` line per request (route, status, ms). Routes log domain events.
- **Redaction:** `log.js` drops the keys `payer`, `shipTo`, `email`, `name`, `address` and `phone` at any depth before writing. Payer and address data never reach logs; order ids, SKUs and amounts may.
- Logs live in Workers Logs (`[observability] enabled = true`). Retention is 3 days on the free plan and 7 on paid. Use the dashboard query builder to filter and group by event, code and route. Use `wrangler tail` for a live view.

### Event catalog

| Event | Level | Fields |
|---|---|---|
| `request` | info / warn ≥400 / error ≥500 | route, status, ms |
| `era.list` | info | count |
| `bag.quoted` | info | counts per line status, totalCents |
| `order.created` | info | orderId, totalCents |
| `order.refused` | warn | code |
| `order.captured` | info | orderId, totalCents |
| `capture.refused` | warn (error for `tag-mismatch` / `amount-mismatch`) | orderId, code |
| `paypal.error` | error | op, upstreamStatus |
| `order.log_failed` | error | orderId |
| `email.sent` / `email.failed` / `email.gave_up` | info / warn / error | orderId, recipient (`customer` / `owner`), attempts |
| `client.error` | warn | event, code, route, reqId |
| `alert.sent` / `alert.suppressed` | info | alertEvent |
| `unhandled` | error | message, stack |

### Alerts

`lib/alerts.js` emails `OWNER_EMAIL` through Resend.

| Trigger | Reason |
|---|---|
| `order.log_failed` | Money taken, record missing. The alert includes the full record |
| `capture.refused` with `tag-mismatch` | Possible tampering |
| Captured amount mismatch | Possible tampering or PayPal anomaly |
| `email.gave_up` | Customer never got a receipt |
| 5 or more `paypal.error` within a 10-minute bucket | Checkout likely down |
| `unhandled` | Bug |

- **Dedup:** before sending, check KV `alert:<event>`. If it is present, log `alert.suppressed` and skip. Otherwise send and write it with TTL 1 hour. Exception: `order.log_failed` alerts are never deduped, because each one carries a unique order record.
- **PayPal error burst:** a KV counter `paypal-errors:<10-minute bucket>` with TTL 20 minutes. The alert fires when it reaches 5.
- Alert sending failures are logged and never thrown, so an alert can never break a request.

### Uptime

A free external monitor (UptimeRobot or Better Stack) checks `https://api.evincus.shop/api/health` and the Pages homepage every 5 minutes and alerts the owner by email or SMS. This catches a Worker outage, which the Worker can't alert about itself. Setup is manual and documented in the README.

## 7. Site changes

- `data/products.js` is replaced by `data/catalog.js`, which loads `data/*.json`. It keeps the existing exports that pages use (`PRODUCTS`, `CATEGORIES`, `LOOKBOOK`, `findProduct`, `imagesFor`, `money`), adapted to cents.
- **Browsing:** pages fetch `/api/eras`, `/api/eras/:slug` and `/api/products/:id`. If the API can't be reached, they render from static JSON with every product marked "Checking availability" and with checkout disabled, and they send the `api-unreachable` beacon once per session.
- **Bag:** `cart.js` keeps localStorage. The bag view calls `/api/bag/quote` on open and after each change (debounced 300 ms), and shows each line's status. The bag offers "Remove unavailable items" when any line isn't buyable, and the checkout button is disabled until `checkoutReady`.
- **Checkout:** `paypal.js` points at `API_BASE + /api/orders` and `/api/orders/capture`. A 409 `bag-changed` updates the bag with the returned lines and shows the error message.
- **Era routes:** `#/eras/:slug` shows an era page. Upcoming eras show a teaser with the drop date in the shopper's local time.
- Visual design of the era page and the bag status UI is out of scope here. This work adds minimal, functional states, and a separate frontend-design pass will style them.
- All new CSS and JS goes in `assets/css` and `assets/js`. No inline styles or scripts.

## 8. Testing

All tests use `node --test`, with no new dependencies. Worker code uses only `fetch`, `Request`/`Response`, `URL` and `crypto.subtle`, which Node 20 provides.

- **`catalog.test.mjs`:** era status exactly at, one millisecond before, and one millisecond after `dropsAt` and `endsAt`; the visibility table; product-level and variant-level sold out; the cache-age calculation.
- **`pricing.test.mjs`:** the existing `orders.test.mjs` cases ported to cents, plus each quote line status, `checkoutReady`, and no name or price leakage for `not-released` and `unknown-item` lines.
- **`data.test.mjs`:** JSON parses; ids and slugs are unique; each product's `era` exists; `soldOutVariants` entries reference real colours and sizes; `priceCents` is a positive integer; dates are valid ISO with an offset; `imagesFor()` output matches the pre-migration snapshot.
- **`routes.test.mjs`:** calls the Worker's default export `fetch(req, env, ctx)` with `helpers/fake-env.mjs`:
  - GET routes, including 404 for upcoming products and the cache header
  - quote statuses and malformed-input 400s
  - create: 409 `bag-changed`, and a valid HMAC tag
  - capture: idempotency (the second call makes no PayPal request), refusal codes, the buyable check at capture, amount mismatch, and a KV write failure that still returns 200 and sends an alert
  - email: success, failure leading to a retry key, cron retry backoff, and give-up with an alert
  - alert dedup, and the PayPal error burst
  - beacon schema, size and rate limiting
  - CORS allow and deny, and the OPTIONS preflight
  - **redaction:** capture every log line during the suite and assert that none contains payer or address data
- **Manual end-to-end:** `wrangler dev` with the PayPal sandbox, from adding to the bag through receipt email.

## 9. Deployment

### Environments

| | Worker | PayPal | KV | Deployed by |
|---|---|---|---|---|
| staging | `evincus-api-staging` (workers.dev URL) | sandbox | `ORDERS_STAGING` | manual `workflow_dispatch` |
| production | `evincus-api` on `api.evincus.shop` | `PAYPAL_ENV=sandbox` until launch, then `live` | `ORDERS` | push to `main` |

- **Vars in `wrangler.toml`:** `PAYPAL_ENV`, `PAYPAL_CLIENT_ID`, `SHIPPING_USD`, `OWNER_EMAIL`, `ALLOWED_ORIGINS`, `COMMIT_SHA` (overridden at deploy).
- **Secrets**, set once with `wrangler secret put`: `PAYPAL_CLIENT_SECRET`, `ORDER_HMAC_KEY`, `RESEND_API_KEY`.
- **GitHub secrets:** only `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.

### CI

`.github/workflows/deploy.yml` runs three jobs in order:

1. `test`: `node --test`.
2. `deploy-worker`: `cloudflare/wrangler-action`, which runs `wrangler deploy --var COMMIT_SHA:${{ github.sha }}`.
3. `deploy-pages`: uploads only `index.html`, `pages/`, `assets/`, `data/` (and any other public HTML), using `actions/upload-pages-artifact` and `actions/deploy-pages`.

Each job runs only if the previous one succeeded, so the site never gets ahead of the API.

### Free-tier limits

| Resource | Free limit | Expected use |
|---|---|---|
| Worker requests | 100k/day | well below |
| KV reads | 100k/day | well below |
| KV writes | 1k/day | about 3 per order, plus retries, alerts and counters |

Move to Workers Paid ($5/month) once orders are sustained above about 300/day, or when 7-day log retention is wanted.

## 10. Migration order

Each step leaves `main` deployable and its tests green.

1. Convert `data/products.js` to `data/*.json` plus `data/catalog.js`. The site reads it with no visible change.
2. Worker skeleton: router, CORS, `log.js`, `http.js`, catalog routes, `/api/health`, and tests.
3. Port pricing and PayPal; implement quote, create and capture; add parity tests against the current Netlify behaviour.
4. KV order log, emails, cron retry, and alerts.
5. Beacon and rate limiting.
6. Site switches to the API: bag quote statuses, era routes, and the static fallback.
7. CI deploy: run staging end to end, then production.
8. Delete `netlify/` and `netlify.toml`, delete `tests/orders.test.mjs` (superseded), and update the README with the new run, deploy, secrets and uptime-monitor instructions.

## 11. Later: move to Cloudflare

Serve the static site from the same Worker (static assets) or from Cloudflare Pages on `evincus.shop`, with `/api/*` routed to the Worker. Then set `API_BASE = ''`, reduce `ALLOWED_ORIGINS` to same-origin, and remove the Pages job from CI. No API code changes.
