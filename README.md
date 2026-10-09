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
