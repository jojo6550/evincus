# Evincus storefront

One Node app on Render serves the static store and its API (`/api/*`) from the same origin. Vanilla ES modules, with
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
- `main.js`: the Node entry (KV, cron, `node:http`). `server/`: the API router (`index.js`), `routes`, `lib`,
  `emails`, and the static file server (`static.js`). `server/` only uses web-standard `Request`/`Response`.
- `policies.html`: customer-facing privacy, shipping, refund, terms and FAQ content,
  linked from the store, eras page and checkout. Refund requests have a 24-hour
  window from purchase. `docs/policies/original-evincus-shop.md` preserves the
  recovered homepage source and records the adaptation decisions.

## Run locally

Needs Node 22.9 or later. KV is Deno KV via the `@deno/kv` npm package, stored in `.kv.sqlite3` locally.

```bash
npm install
cp .env.example .env        # local settings; .env is never committed
npm run dev                 # site and API on http://localhost:8000/
```

Local KV is separate from production, so test orders, subscribers and sales never touch the live store.
`ENVIRONMENT=development` in `.env` turns on the error page preview (`npm run error 503` prints its URL);
any value other than `production` also lets other localhost origins through CORS.

## Catalog changes

Each era is a folder in `data/eras/`. Image fields in `era.js` are bare filenames from that era's `img/` folder,
lowercase-kebab (`core-tee-black-1.jpg`), max 500 KB each.

| Task | How |
| --- | --- |
| Add an era | `npm run new-era -- <slug> "<Name>"`, add photos to its `img/`, fill in `era.js`, remove every `TODO` |
| Schedule a drop | Set `dropsAt` (ISO with offset, e.g. `2026-11-20T18:00:00-05:00`). Until then the API shows only a teaser |
| Retire an era | Set `endsAt`. Its products stay visible but can't be bought, and old links keep working |
| Delete an era | Delete its folder and its two lines in `data/eras/index.js` |
| Add photos | `npm run photos -- <era> <product-id> [--color "<Colour>"] <photo...>`, or `npm run photos -- <era> hero <photo>`. Any size or format in: they're turned upright, fit to 1800 px, saved as webp under 500 KB with the next free name, and added to `era.js` |
| Add, edit or remove a product | Edit that era's `products` array and add or remove its photos |
| Move a product to another era | Move its object and its photos to the other folder |
| Sold out | `soldOut: true` for a whole product, or `soldOutVariants: ['Black\|XL']` for one colour and size |
| Replace a stand-in photo | Overwrite the file in `img/` with the same name |

Then `npm test`, push to `dev`, merge into `main`, then into `prod`. Only `prod` deploys, and only after the tests pass; the tests check folder names, photos and data.

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

Add `local` for `npm run dev`, `url=https://evincus.onrender.com` before the domain points at Render, `dry-run` to preview (plain words, no
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

Render builds `Dockerfile` (`node:22-slim`, `npm ci --omit=dev`, `node main.js`) for both services in `render.yaml`: site, API and the 15-minute cron in one process,
with KV in a SQLite file on a 1 GB persistent disk (`KV_PATH=/var/data/kv.sqlite3`, snapshotted daily by Render).
`.github/workflows/ci.yml` runs the tests on every push; on `prod` it then triggers a Render deploy of that exact
commit, waits until `/api/health` reports it with `"ok":true`, and smoke-tests the pages, assets and API. Render's
own auto-deploy is off, so a failing test never ships. Other branches are tested but not deployed.

The disk needs a paid instance and keeps the service at one instance, so each deploy has a few seconds of downtime.
Do not move to the free plan: it has no disk, and it sleeps when idle, which stops the cron.
The `evincus-dev` service (same Blueprint, branch `dev`, values in the gitignored `.env.render-dev`) runs free and
deploys itself once a `dev` push passes CI (`autoDeployTrigger: checksPass`): `KEEPALIVE_URL` makes it call its own
`/api/health` every 10 minutes so it never sleeps, and its KV in `/tmp` resets on each deploy.

### First deploy checklist (Render)

Render hosts everything: the app, the KV disk, the `evincus.shop` domain and its TLS, and the deploys. Email is the
only outside service (Resend). `render.yaml` sets every fixed value, including `SITE_URL` and `API_URL`
(`https://evincus.shop`). The API is same-origin, so `ALLOWED_ORIGINS` stays unset.

1. Render, New, **Blueprint**, pick this repo. It creates the service, disk and domain, and asks once for:

   | Variable | Value |
   | --- | --- |
   | `DELIVERY_EXCLUDED_COUNTRIES` | comma-separated ISO codes, or blank |
   | `OWNER_EMAIL` | where order summaries and alerts go |
   | `POSTAL_ADDRESS` | printed in newsletter footers |
   | Secrets: `RESEND_API_KEY`, `ORDER_HMAC_KEY`, `NEWSLETTER_KEY`, `ADMIN_TOKEN` | long random values. `ADMIN_TOKEN` also goes in your local `.env` for `npm run discount` |

2. Service `evincus`, Settings, **Deploy Hook**: copy the URL into GitHub, Settings, Secrets and variables, Actions,
   as the secret `RENDER_DEPLOY_HOOK_URL`.
3. Service `evincus`, Settings, Custom Domains: add the DNS records Render shows for `evincus.shop` at the registrar.
   Until they resolve, add the GitHub Actions variable `RENDER_URL=https://evincus.onrender.com` so CI checks that
   address, and pass `url=https://evincus.onrender.com` to `npm run discount`. Delete the variable afterwards.
4. Verify the sending domain in Resend.
5. Merge `main` into `prod` and push. The Actions run must end green, then place a delivery and a pickup test order on the live site.
6. Once Render serves the domain, delete the old Deno Deploy app so it stops running its own cron and emails.
7. Keep `PAYMENT_MODE=none`.

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

- **Logs:** Render dashboard, service `evincus`, Logs. Every line is JSON with `event`, `reqId` and `route`.
  Errors shown to shoppers include the request id.
- **Alerts:** emailed to `OWNER_EMAIL` for unsaved paid orders, possible tampering, undelivered receipts,
  PayPal outages (5+ errors in 10 minutes) and unhandled errors. At most one per event type per hour.
- **Uptime (set up once by hand):** create a free UptimeRobot or Better Stack **keyword (GET) monitor** for
  `<live URL>/api/health` that expects `"ok":true`. Do not use a plain
  HEAD/HTTP monitor: `/api/health` answers GET only and returns 405 to HEAD. Add a second monitor for the homepage.
  Check both every 5 minutes, alerting by email or SMS. This catches the app being down, which it can't report itself.
- **Deploys:** a failed deploy shows as a red `deploy` job in GitHub Actions; Render keeps the previous version
  running when a new one fails its health check.
