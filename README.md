# Evincus storefront

Static store on GitHub Pages plus an API on a Cloudflare Worker. No build step: vanilla ES modules and the PayPal JS
SDK checkout. Design spec: `docs/superpowers/specs/2026-10-03-backend-bag-eras-design.md`.

## Layout

- `index.html`: the whole site, a single dark "Catastrophe" landing page with an era filter, product view dialog,
  bag drawer and in-drawer PayPal checkout.
- `assets/js`: `index.js`, `store.js`, `api.js`, `cart.js`, `quote.js`, `bag.js`, `product-view.js`, `paypal.js`.
  Styles are in `assets/css/index.css`.
- `data/eras.json`, `data/products.json`, `data/site.json`: the catalog. Edit these to add drops, change prices or mark things sold out.
- `data/catalog.js`: catalog rules shared by the site and the API (era status, what's visible, what's buyable).
- `worker/`: the API (`wrangler.toml`, `src/index.js` router, `src/routes`, `src/lib`, `src/emails`).

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
PAYPAL_CLIENT_SECRET=...
ORDER_HMAC_KEY=...
RESEND_API_KEY=...
```

## Catalog changes

- **New era:** add it to the top of `data/eras.json` with `dropsAt` (ISO with offset, e.g. `2026-11-20T18:00:00-05:00`).
  Until then the API shows only a teaser and its products can't be seen or bought. If the repo is public,
  the JSON itself is readable on GitHub before the drop.
- **End an era:** set `endsAt`. Its products stay visible but can't be bought.
- **Sold out:** `"soldOut": true` for a whole product, or `"soldOutVariants": ["Black|XL"]` for one colour and size.
- Push to `main`. Tests check the data before anything deploys.

## Tests

```bash
node --test
```

## Deploy

Push to `main`: CI runs the tests, deploys the Worker, then deploys Pages. Run the workflow manually with `staging` to
deploy only the staging Worker.

| Where | What |
| --- | --- |
| `worker/wrangler.toml` `[vars]` | `PAYPAL_ENV`, `PAYPAL_CLIENT_ID`, `SHIPPING_USD`, `OWNER_EMAIL`, `EMAIL_FROM`, `ALLOWED_ORIGINS` |
| `wrangler secret put` | `PAYPAL_CLIENT_SECRET`, `ORDER_HMAC_KEY`, `RESEND_API_KEY` |
| GitHub secrets | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` |
| GitHub variables | `PAYPAL_CLIENT_ID`, `API_BASE` (written into `assets/js/config.js` at deploy) |

### First deploy checklist

`worker/wrangler.toml` ships with `REPLACE_WITH_*` placeholders (sandbox client id, owner email, staging KV id) and
production KV `id = "local-orders"`. Before the first deploy:

1. `npx wrangler login`.
2. Create the KV namespaces `ORDERS` and `ORDERS_STAGING` and paste their ids into `worker/wrangler.toml`.
3. Fill in every `REPLACE_WITH_*` value.
4. Run `wrangler secret put` for `PAYPAL_CLIENT_SECRET`, `ORDER_HMAC_KEY` and `RESEND_API_KEY`, for both
   environments (default and `--env staging`).
5. GitHub secrets: `CLOUDFLARE_API_TOKEN` (scoped to Workers Scripts: Edit and Workers KV Storage: Edit) and
   `CLOUDFLARE_ACCOUNT_ID`.
6. GitHub variables: `PAYPAL_CLIENT_ID` and `API_BASE`.
7. Settings, Pages, Source = GitHub Actions.
8. Verify the sending domain in Resend.
9. Run the workflow manually with target `staging` first.
10. If the `evincus.shop` DNS is on Cloudflare, add the custom-domain route for the Worker.

## Payments

The browser sends only product id, colour, size and quantity. The Worker prices the bag from the catalog, creates
the PayPal order with a server-signed tag, and at capture re-checks the tag, re-prices every line, checks every line
is still buyable, then verifies the captured amount. Each order is saved to KV for 2 years; the customer gets a
receipt and the owner a notification through Resend, with retries every 15 minutes if sending fails.

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
