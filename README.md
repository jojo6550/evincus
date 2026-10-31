# Evincus storefront

One Node app on Render serves the static store and its API (`/api/*`) from the same origin. Vanilla ES modules, with
no build step. Checkout places orders directly. **No payment service is used and no payment is collected.**

## Layout

- `index.html`: the whole site, a single dark "Catastrophe" landing page with an era filter, product view dialog,
  bag drawer and in-drawer pickup checkout.
- `assets/js`: `index.js`, `store.js`, `api.js`, `cart.js`, `quote.js`, `bag.js`, `product-view.js`, `checkout.js`.
  Styles are in `assets/css/index.css`.
- `data/eras/<slug>/`: one folder per era. `era.js` holds the era and its products; `img/` holds that era's photos.
  `data/eras/index.js` sets the order (newest first). `data/site.json` holds site copy.
- `assets/img/`: every photo that doesn't belong to an era (logo, favicon, `site/` lookbook and banners).
- `data/catalog.js`: catalog rules shared by the site and the API (era status, what's visible, what's buyable).
- `main.js`: the Node entry (KV, cron, `node:http`). `server/`: the API router (`index.js`), `routes`, `lib`,
  `emails`, and the static file server (`static.js`). `server/` only uses web-standard `Request`/`Response`.
- `policies.html`: customer-facing privacy, pickup, refund, terms and FAQ content,
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

The live catalog is in the server's store and is changed in `/inventory` (sign in as an owner). Changes are live on save,
with no deploy. `data/eras/` is seed data only: it fills an empty store once and editing it changes nothing live.

| Task | How |
| --- | --- |
| Add an era | Inventory › Eras › **+ Era**, or `npm run new-era <slug> "<Name>" [local] [url=<base>]` for a draft. Fill it in, set Status to Published, Save |
| Schedule a drop | Open the era, set **Drops at**, Save. Until then shoppers see only a teaser |
| Retire an era | Open the era, set **Ends at**, Save. Its products stay visible but can't be bought, and old links keep working |
| Delete an era | Set its Status to **Archived**. Eras are never deleted, so old orders and links keep working |
| Add, edit or remove a product | Inventory › **+ Product**, or open the product, edit and Save. To remove one, set its Status to **Archived** (or **Draft** to hide it for now) |
| Move a product to another era | Open the product, change **Era**, Save. Its photos move with it |
| Sold out | Open the product and set that size's stock to 0, with **Keep selling when out of stock** off. It shows Sold out by itself |
| Add or replace a photo | On the product (or era hero) page, add the new photo and remove the old one, then Save. Or `npm run photos -- <era> <product-id> [--color "<Colour>"] <photo...> [local] [url=<base>]` (`npm run photos -- <era> hero <photo>` for a hero); in PowerShell write `color="<Colour>"` instead of `--color`. Needs `ADMIN_TOKEN` |

Code changes still go `npm test`, push to `dev`, merge into `main`, then into `prod`. Only `prod` deploys, and only after the tests pass.

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
server's, in your environment or `.env`. Overlapping sales don't stack: each product gets its era's deepest one.
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
| Link signing key | `NEWSLETTER_KEY` secret |
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
   | `OWNER_EMAIL` | where order summaries and alerts go |
   | `POSTAL_ADDRESS` | printed in newsletter footers |
   | Secrets: `RESEND_API_KEY`, `NEWSLETTER_KEY`, `ADMIN_TOKEN` | Use the provider-issued Resend key and distinct random values of at least 32 characters for the other two. `ADMIN_TOKEN` also goes in your local `.env` for `npm run discount` |

2. Service `evincus`, Settings, **Deploy Hook**: copy the URL into GitHub, Settings, Secrets and variables, Actions,
   as the secret `RENDER_DEPLOY_HOOK_URL`.
3. Service `evincus`, Settings, Custom Domains: add the DNS records Render shows for `evincus.shop` at the registrar.
   Until they resolve, add the GitHub Actions variable `RENDER_URL=https://evincus.onrender.com` so CI checks that
   address, and pass `url=https://evincus.onrender.com` to `npm run discount`. Delete the variable afterwards.
4. Verify the sending domain in Resend.
5. Merge `main` into `prod` and push. The Actions run must end green, then place a pickup test order on the live site.
6. Once Render serves the domain, delete the old Deno Deploy app so it stops running its own cron and emails.

## Inventory

`/inventory` is the staff page: sign in, then use the Inventory, Orders, Stats and Logs tabs (Logs is for owners
only). It is never linked from the store, carries `noindex`, is disallowed in `robots.txt`, and stays reachable
while `STATUS` closes the public site.

- **Roles:** `viewer` can look; `owner` can also change things and see Logs.
- **Accounts** are made from your own machine, never on the site. They need `ADMIN_TOKEN` in your environment or `.env`:
  ```bash
  npm run add-viewer you@example.com owner     # create a login, or reset its password; prints a generated password
  npm run remove-viewer you@example.com        # delete a login; its sessions stop working
  npm run list-viewers
  ```
  Add `local` to talk to `npm run dev` on localhost, or `url=<base>` for another server.
- **Live vs local:** the page shows a LOCAL badge when the server runs with `ENVIRONMENT=development`. Local KV is
  separate from production, so nothing done there touches the live store.
- **Pull the live catalog:** `npm run inventory:pull` (or `url=<base>` for another source) copies eras, products, stock and photos from the live site into your running `npm run dev`, so `/inventory` has real data to try things on. It needs `PROD_ADMIN_TOKEN` in `.env` (the live `ADMIN_TOKEN`; keep your local `ADMIN_TOKEN` different), never copies orders, accounts, sessions or logs, and the local server refuses the import unless it is a development server reached from your own machine.
- **Rollout:** stock the shop at `/inventory` while `STATUS=stocking`, then open the store with WiPay.
- `data/eras/` is seed data. Once the store is live, stock and products are managed in `/inventory`, not by editing those files.

## Orders and fulfillment

`POST /api/orders` accepts `checkoutToken` (a UUID), `items`, `customer` (`name`, `email`, `phone`),
`fulfillment`, optional `notes`, and `expectedTotalCents`. The server checks catalog prices, availability,
variants and quantities; mismatched totals require reviewing the bag. Orders are `PLACED`, with
`paymentStatus: NOT_COLLECTED`. There is no payment integration: the checkout's Pay button places the order,
shows "Payment complete" and clears the cart, but charges nothing.

Pickup is the only fulfillment option for now and is free. There is no delivery or shipping.

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
pickup selections, notes and order totals. Empty days also send a summary. This is order
value, not collected revenue. Summaries split into parts of 20 orders. The 15-minute cron queues summaries
after 08:00 and retries failed deliveries with stable Resend idempotency keys and saved email bodies.
Completed summary markers prevent subsequent sends. A saved cursor catches up after missed cron days.
Customer confirmations use the existing bounded backoff.

Configure `OWNER_EMAIL`, `EMAIL_FROM` and the `RESEND_API_KEY` secret, and verify the sending domain in Resend
before deployment. Use a separate test recipient for previews so test orders do not enter the production mailbox.
No real email delivery is verified by the automated tests.

## Monitoring

Use the [security and optimization checklist](docs/security-and-optimization-checklist.md) to track release checks, security improvements, performance work, and recurring maintenance.

The [operations guide](docs/security-operations.md) covers credential rotation, isolated restore checks, retention, monitoring, and rollback compatibility. Production starts only with distinct signing/admin secrets. Security headers apply to the site and API; production CSP starts in report-only mode for rollout, while staging enforces it and disables email. The app monitors free disk and overdue cron completion through `/api/health`.

Run `npm run optimize:images` after adding photos. Responsive versions preserve the originals; generated photo URLs have content versions and long cache lifetimes. `npm run check:performance`, `npm run check:load`, and `npm run check:restore` provide repeatable local checks. Load and restore checks use disposable storage and never send real email. CI also checks private-file exclusions, dependencies, and the unprivileged production container.

- **Logs:** Render dashboard, service `evincus`, Logs. Every line is JSON with `event`, `reqId` and `route`.
  Errors shown to shoppers include the request id.
- **Alerts:** emailed to `OWNER_EMAIL` for undelivered receipts and unhandled errors. At most one per event
  type per hour.
- **Uptime (set up once by hand):** create a free UptimeRobot or Better Stack **keyword (GET) monitor** for
  `<live URL>/api/health` that expects `"ok":true`. Do not use a plain
  HEAD/HTTP monitor: `/api/health` answers GET only and returns 405 to HEAD. Add a second monitor for the homepage.
  Check both every 5 minutes, alerting by email or SMS. This catches the app being down, which it can't report itself.
- **Deploys:** a failed deploy shows as a red `deploy` job in GitHub Actions; Render keeps the previous version
  running when a new one fails its health check.
