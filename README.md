# Evincus storefront

Static store on GitHub Pages plus an API on a Cloudflare Worker. Vanilla ES modules, with no build step.
Checkout places orders directly. **No payment service is used and no payment is collected.**

## Layout

- `index.html`: the whole site, a single dark "Catastrophe" landing page with an era filter, product view dialog,
  bag drawer and in-drawer delivery / pickup checkout.
- `assets/js`: `index.js`, `store.js`, `api.js`, `cart.js`, `quote.js`, `bag.js`, `product-view.js`, `checkout.js`.
  Styles are in `assets/css/index.css`.
- `data/eras/<slug>/`: one folder per era. `era.js` holds the era and its products; `img/` holds that era's photos.
  `data/eras/index.js` sets the order (newest first). `data/site.json` holds site copy.
- `assets/img/`: every photo that doesn't belong to an era (logo, favicon, `site/` lookbook and banners).
- `data/catalog.js`: catalog rules shared by the site and the API (era status, what's visible, what's buyable).
- `worker/`: the API (`wrangler.toml`, `src/index.js` router, `src/routes`, `src/lib`, `src/emails`).
- `policies.html`: customer-facing privacy, shipping, refund, terms and FAQ content,
  linked from the store, eras page and checkout. Refund requests have a 24-hour
  window from purchase. `docs/policies/original-evincus-shop.md` preserves the
  recovered homepage source and records the adaptation decisions.

## Run locally

```bash
npm install
cp assets/js/config.example.js assets/js/config.js   # API_BASE = 'http://localhost:8787'
npm run dev:api                                        # API on http://localhost:8787
npx http-server -p 5180 -c-1 .                         # site on http://localhost:5180/ (or /index.html)
```

`worker/.dev.vars` (next to `wrangler.toml`, gitignored) holds local secrets and `ENVIRONMENT=development`
(which lets localhost through CORS):

```
ENVIRONMENT=development
RESEND_API_KEY=...
```

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

Sales change live prices with no deploy. They're stored in the API's `ORDERS` KV (key `config:sales`), show a countdown
banner on the site, and reach shoppers within about a minute. Start and end times are exact.

| Task | How |
| --- | --- |
| Discount one era | `npm run discount -- catastrophe 3 20` (3 days, 20% off) |
| Discount a group of eras | `npm run discount -- catastrophe,core 7 15 --label "Fall sale"` |
| Discount everything | `npm run discount -- all 2 30` |
| Schedule a sale | add `--starts 2026-11-27T00:00:00-05:00` |
| See sales | `npm run discount -- list` |
| End a sale early | `npm run discount -- end <id>` or `end all` |

Add `--staging` for staging, `--local` for `npm run dev:api`, `--dry-run` to preview. Overlapping sales don't stack: each
product gets its era's deepest one. A PayPal order approved in the last 15 minutes of a sale still captures at the sale price.
Everything in `data/` is published to Pages, so an era's folder (`era.js`, photos) can be fetched from the live site
once it's pushed, even with a private repo. The API keeps an upcoming era unbuyable, but it isn't secret. To keep a drop
secret, push its folder on drop day.

## Tests

```bash
node --test
```

## Deploy

Push to `main`: CI runs the tests, deploys the Worker, then deploys Pages. Run the workflow manually with `staging` to
deploy only the staging Worker.

| Where | What |
| --- | --- |
| `worker/wrangler.toml` `[vars]` | `PAYMENT_MODE = "none"`, `SHIPPING_USD`, `DELIVERY_EXCLUDED_COUNTRIES`, `OWNER_EMAIL`, `EMAIL_FROM`, `ALLOWED_ORIGINS` |
| `wrangler secret put` | `RESEND_API_KEY` |
| GitHub secrets | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` |
| GitHub variables | `API_BASE` (written into `assets/js/config.js` at deploy) |

### First deploy checklist

`worker/wrangler.toml` ships with `REPLACE_WITH_*` placeholders (owner email, staging KV id) and
production KV `id = "local-orders"`. Before the first deploy:

1. `npx wrangler login`.
2. Create the KV namespaces `ORDERS` and `ORDERS_STAGING` and paste their ids into `worker/wrangler.toml`.
3. Fill in every `REPLACE_WITH_*` value.
4. Run `npx wrangler secret put RESEND_API_KEY --config worker/wrangler.toml`, for both
   environments (default and `--env staging`).
5. GitHub secrets: `CLOUDFLARE_API_TOKEN` (scoped to Workers Scripts: Edit and Workers KV Storage: Edit) and
   `CLOUDFLARE_ACCOUNT_ID`.
6. GitHub variable: `API_BASE` pointing to the deployed Worker.
7. Settings, Pages, Source = GitHub Actions.
8. Verify the sending domain in Resend.
9. The rate limit `namespace_id` values (`1001`–`1004`, beacon and order limits) must be unique in your Cloudflare
   account. Change them if another Worker already uses them.
10. Deploy staging from your machine: `npm run deploy:api -- --env staging`. Test a delivery and a pickup order: run
    the site on localhost with `API_BASE` in `assets/js/config.js` set to the staging Worker URL, and temporarily add
    `http://localhost:5180` to the staging `ALLOWED_ORIGINS`. Only then merge to `main`: merging is the first
    production deploy (the workflow refuses to run while `wrangler.toml` still has placeholders).
11. Keep `PAYMENT_MODE = "none"`. The Durable Object binding and SQLite migration are deployed with the Worker.
12. Merging deletes the Netlify functions. If Netlify still deploys this repo, disconnect it only after Pages and the
    Worker are confirmed live.
13. If the `evincus.shop` DNS is on Cloudflare, add the custom-domain route for the Worker.

## Orders and fulfillment

`POST /api/orders` accepts `checkoutToken` (a UUID), `items`, `customer` (`name`, `email`, `phone`),
`fulfillment`, optional `notes`, and `expectedTotalCents`. The Worker checks catalog prices, availability,
variants and quantities; mismatched totals require reviewing the bag. Orders are `PLACED`, with
`paymentStatus: NOT_COLLECTED`. `/api/orders/capture` is disabled. No PayPal SDK loads in checkout.

Delivery uses an ISO country dropdown including the USA and Canada. Set `DELIVERY_EXCLUDED_COUNTRIES` to a
comma-separated list of ISO codes when exclusions are known. The current list allows all ISO countries;
carrier restrictions must be configured before launch. Delivery uses the existing flat `SHIPPING_USD` setting
(currently zero); set the confirmed delivery charge before launch. Pickup is free.

`data/fulfillment.js` holds the two pickup locations: Trendy Hats and Vince's store, both in Mandeville,
Manchester, Jamaica. Their addresses are intentionally empty until confirmed. Fill each `address` there;
checkout and confirmations use the same settings. Customers are contacted when pickup is ready.

A Durable Object serializes each checkout token and retains the order for two years. The same token and
payload return the same order, even if catalog availability changes after placement. Different payloads
using the same token are refused. The order and Jamaica-day index must reach KV before success is returned;
a failed write can be repaired by retrying the same submission. The browser keeps an uncertain submission
in session storage and retries it without creating a new order. Only ordered quantities are removed from the bag.

Customers receive a Resend confirmation after placement. The owner receives a daily summary of the previous
Jamaica calendar day's orders at **08:00 America/Jamaica (13:00 UTC)**, including contact details, line items,
delivery addresses or pickup selections, notes and order totals. Empty days also send a summary. This is order
value, not collected revenue. Summaries split into parts of 20 orders. The 15-minute cron queues summaries
after 08:00 and retries failed deliveries with stable Resend idempotency keys and saved email bodies.
Completed summary markers prevent subsequent sends. A saved cursor catches up after missed cron days.
Customer confirmations use the existing bounded backoff.

Configure `OWNER_EMAIL`, `EMAIL_FROM`, the production/staging KV IDs and the `RESEND_API_KEY` secret,
and verify the sending domain in Resend before deployment. Use a separate staging recipient so test orders
do not enter the production mailbox. No real email delivery is verified by the automated tests.

Legacy PayPal code remains available only behind explicit `PAYMENT_MODE = "paypal"` for future development;
enabling it also requires restoring the payment UI and credentials. Do not change that setting for this release.

## Monitoring

- **Logs:** Cloudflare dashboard, Workers, evincus-api, Logs. Every line is JSON with `event`, `reqId` and `route`.
  Errors shown to shoppers include the request id. Live view: `npx wrangler tail --config worker/wrangler.toml`.
- **Alerts:** emailed to `OWNER_EMAIL` for unsaved paid orders, possible tampering, undelivered receipts,
  PayPal outages (5+ errors in 10 minutes) and unhandled errors. At most one per event type per hour.
- **Uptime (set up once by hand):** create a free UptimeRobot or Better Stack **keyword (GET) monitor** for
  `https://api.evincus.shop/api/health` that expects `"ok":true`. Do not use a plain HEAD/HTTP monitor:
  `/api/health` answers GET only and returns 405 to HEAD. Add a second monitor for the Pages homepage. Check both
  every 5 minutes, alerting by email or SMS. This catches the Worker being down, which it can't report itself.
- **Free tier:** KV allows 1,000 writes/day (each order uses about 3). Move to Workers Paid ($5/month) above about
  300 orders/day or for 7-day log retention.
