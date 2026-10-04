# Evincus storefront

Static store on GitHub Pages plus an API on a Cloudflare Worker. No build step: vanilla ES modules and the PayPal JS
SDK checkout. Design spec: `docs/superpowers/specs/2026-10-03-backend-bag-eras-design.md`.

## Layout

- `index.html`: the whole site, a single dark "Catastrophe" landing page with an era filter, product view dialog,
  bag drawer and in-drawer PayPal checkout.
- `assets/js`: `index.js`, `store.js`, `api.js`, `cart.js`, `quote.js`, `bag.js`, `product-view.js`, `paypal.js`.
  Styles are in `assets/css/index.css`.
- `data/eras/<slug>/`: one folder per era. `era.js` holds the era and its products; `img/` holds that era's photos.
  `data/eras/index.js` sets the order (newest first). `data/site.json` holds site copy.
- `assets/img/`: every photo that doesn't belong to an era (logo, favicon, `site/` lookbook and banners).
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
6. GitHub variables: `PAYPAL_CLIENT_ID` and `API_BASE`. The PayPal client ID in the repo variable and in
   `worker/wrangler.toml` must be identical.
7. Settings, Pages, Source = GitHub Actions.
8. Verify the sending domain in Resend.
9. The rate limit `namespace_id` values (`1001` production, `1002` staging) must be unique in your Cloudflare
   account. Change them if another Worker already uses them.
10. Deploy staging from your machine: `npm run deploy:api -- --env staging`. Test a sandbox purchase against it: run
    the site on localhost with `API_BASE` in `assets/js/config.js` set to the staging Worker URL, and temporarily add
    `http://localhost:5180` to the staging `ALLOWED_ORIGINS`. Only then merge to `main`: merging is the first
    production deploy (the workflow refuses to run while `wrangler.toml` still has placeholders).
11. Before merging, decide sandbox vs live. For live, set `PAYPAL_ENV = "live"` and the live client ID in
    `worker/wrangler.toml` and the `PAYPAL_CLIENT_ID` repo variable together (they must match), or real shoppers will
    see a test checkout.
12. Merging deletes the Netlify functions. If Netlify still deploys this repo, disconnect it only after Pages and the
    Worker are confirmed live.
13. If the `evincus.shop` DNS is on Cloudflare, add the custom-domain route for the Worker.

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
