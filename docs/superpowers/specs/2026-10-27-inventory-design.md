# Inventory system (`/inventory`): design

Date: 2026-10-27. Status: draft for owner approval. Replaces the unbuilt
`2026-10-18-admin-dashboard-design.md` (its account, session and log design is carried over here).

## Intent

Evincus is starting to carry real stock. The owner wants one private place, `evincus.shop/inventory` (and
`localhost:8000/inventory`), modelled on Shopify's admin, to run the store day to day: what is in stock per colour and
size, the products themselves (photos, description, price, cost), the eras they belong to, every order from placement
to pickup, how sales are going, where the money went, and what the system has been doing.

Today the catalog is JS files in git (`data/eras/*/era.js`) that only change through a deploy, and stock is two
hand-set flags (`soldOut`, `soldOutVariants`). This design moves eras, products, photos and stock onto the Render
persistent disk so the live site can be edited directly, makes stock counts the source of "sold out", and ties stock
to orders so two shoppers can never buy the last unit.

People the owner trusts can be given read-only access. Accounts are created only by the owner, from their own
machine, with an npm command that generates a random password. Nobody can sign up on the site.

## Goals

1. **Login.** `/inventory` shows an email + password sign-in screen. Signed in, the same URL shows the app.
2. **Two roles.** **Owner**: everything, including all edits. **Viewer**: read-only, never sees customer personal
   data, cost or profit (full matrix below).
3. **Five tabs.** Inventory, Orders, Stats, Finances, Logs. Phone: bottom tab bar. Desktop (≥ 768px): left sidebar,
   lists become tables. Same features on both.
4. **Inventory tab** (approved mockups: `inventory.html` list, `product.html` product page, stock editing option B):
   product list with search, filters and totals; one scrolling page per product with photos per colour, details,
   pricing with cost per item, options, stock per variant with − / + steppers, and history; an Eras section.
5. **Orders tab** (approved mockup: `orders.html`): full order history with views (Open, Ready, Awaiting payment,
   Picked up, Cancelled, All), search and filters; order detail with totals, cost of goods, timeline, internal notes,
   and owner actions: mark ready, mark picked up, cancel, record refund.
6. **Stats tab** (approved mockup: `stats-finances.html`, left): period picker, headline tiles with change vs the
   previous period, sales per day, best sellers, sizes sold, pickup split, running-low list.
7. **Finances tab** (approved mockup: `stats-finances.html`, right; owners only): revenue, refunds, GCT owed, WiPay
   fees, cost of goods, profit, best sellers by profit, refunds list, by-month table, CSV download.
8. **Logs tab** (owners only): errors, warnings, sign-ins, staff actions, filterable; system health panel.
9. **Stock is real.** Each colour × size has On hand, Committed and Available. Checkout refuses quantities above
   Available, atomically. Sold out is derived from stock, not set by hand.
10. **Catalog on disk.** Eras, products and photos live on the Render disk. The live site reads them from there.
    `npm run new-era` and `npm run photos` write to the disk of the chosen server through its API.
11. **CLI** (owner's machine, `ADMIN_TOKEN`, same `local` / `url=<base>` plain-word options as `npm run discount`):
    `add-viewer`, `remove-viewer`, `list-viewers`, `new-era`, `photos`, `inventory:pull`.
12. **Local and remote.** The same page and code run on the live site (real data) and on `localhost` (a sandbox
    with its own KV and photos). `npm run inventory:pull` copies the live catalog, stock and photos down to local.
13. **Efficient, idempotent, consistent.** Every write is one atomic KV commit with version checks; every
    state-changing request carries a client-made operation id so retries and double-taps apply once; a page never
    silently overwrites someone else's newer save.

## Non-goals

- **Payments.** WiPay is a separate, already-written design and plan, built **after** this. Until then orders stay
  `NOT_COLLECTED`, and Finances shows an empty state (see Finances). Holding stock during payment is specified here
  so the WiPay plan can adopt it.
- **Multiple stock locations, transfers, purchase orders, suppliers, barcodes scanning.** One location.
- **Customer emails from order actions** (e.g. "ready for pickup"). Later.
- **Expenses** beyond cost per item (rent, ads, printing runs). Profit is gross profit.
- **Compare-at price.** The existing Sales system (`npm run discount`) already shows discounts.
- **A Sales tab.** `npm run discount` stays as it is.
- **"Only N left" on the storefront.** The store shows Sold out per variant, as today.
- **Deleting products or eras.** They are archived, so order history and stats keep working.
- **Self-service sign-up, password reset, invites, adding viewers from the page.** A forgotten password means the
  owner reruns `add-viewer`.
- **Running more than one server instance.** A Render disk attaches to one instance (see Constraints).
- **Traffic, page views, conversion rates.** Not tracked.

## Anti-goals (failure even if it "works")

- Selling a unit that isn't there: two shoppers both buying the last one, or a retry placing stock twice.
- A double-tap, network retry or two owners acting at once changing stock or an order twice, or one owner's save
  silently overwriting another's.
- Calling order value "revenue". Revenue means money actually charged.
- A way to create accounts or reach inventory data without the owner's `ADMIN_TOKEN` or a valid session.
- A viewer seeing customer name, email, phone, notes, cost, margin or profit.
- Customer personal data in logs, in the CSV export, or copied to the laptop by `inventory:pull`.
- A local sandbox action reaching production data (`inventory:pull` is one-way; the import endpoint does not exist
  in production).
- Phone photos published with their embedded GPS location.
- Changing what shoppers see or pay, other than: prices, photos and copy now come from the disk, and sold out now
  comes from stock.

## Constraints (from the existing project)

- Vanilla ES modules, no build step, **no new runtime dependency**. `sharp` stays a dev dependency, used only by the
  CLI on the owner's machine.
- CSS only in `assets/css/`, JS only in `assets/js/`. No `style=` attributes, no inline `<style>`/`<script>`.
  Mobile first: base CSS for ~375px, scale up with `min-width` queries.
- `server/` uses only web-standard `Request`/`Response`; routes go in the `ROUTES` table in `server/index.js`.
- KV is `env.ORDERS` (`get` / `getEntry` / `put` / `delete` / `list` / `commit`, over `@deno/kv` on SQLite at
  `KV_PATH`). There is no compare-and-set outside `commit` checks. A commit is capped at 800 KiB and its values are
  chunked over 60 KB; `list` returns metadata (≤ 1 KiB per key) but not versions.
- Prod: one paid Render instance (`0.5c-512mb`) with a 1 GB disk at `/var/data`, snapshotted daily by Render. A disk
  can't be shared, so the service can't scale past one instance. Dev service: free, no disk, KV in `/tmp` (reset on
  each deploy). Local: `.kv.sqlite3`.
- The background job runs in-process every 15 minutes (`main.js`).
- Logs are JSON lines with PII stripped (`server/lib/log.js`, `PII_KEYS`).
- Every change ships through `npm test`; new logic gets `node --test` tests in `tests/`.
- Money is integer cents everywhere. Days are Jamaica days (UTC-5, no DST), as in `dayKey`.

## Decided how

### Storage layout

All in the existing KV unless noted. Values are JSON.

| Key | Value | Notes |
|---|---|---|
| `catalog:rev` | `{ rev, eraOrder: [slug…] }` | Bumped in the same commit as every era or product write. `eraOrder` is newest first, as `data/eras/index.js` is today. |
| `era:<slug>` | `{ slug, name, tagline, story, hero, dropsAt, endsAt, state, createdAt, updatedAt }` | `hero` is a photo reference. `state`: `draft` (hidden from shoppers) \| `published` (Live / Upcoming / Ended from the dates, as today) \| `archived` (hidden). |
| `product:<id>` | see Product below | |
| `stock:<id>\|<colour>\|<size>` | `{ onHand, committed }` | Same numbers also in the key's metadata, so one `list` reads all stock. |
| `adj:<id>:<ISO time>:<opId>` | one stock movement | Product history. Kept forever. |
| `op:<opId>` | `{ result }` | Idempotency record, written in the same commit as the change. 7-day TTL. |
| `account:<lowercased email>` | `{ email, role, salt, hash, iterations, epoch, createdAt, lastLoginAt }` | `role`: `owner` \| `viewer`. |
| `session:<sha256(token)>` | `{ email, epoch, expiresAt }` | 7-day TTL. |
| `log:<ISO time>:<random>` | saved log line | 30-day TTL. |
| `order:<id>`, `day:<date>:<id>` | existing, extended (see Orders) | `day:` entries gain summary metadata. No TTL any more; personal data scrubbed after 2 years (see Retention). |

**Photos** are files, not KV: `MEDIA_PATH` (Render: `/var/data/media`; local default `.media/`; dev service
`/tmp/media`). Shoppers must keep getting responsive images as today (`imageAttrs()` with
`assets/js/image-manifest.js`: 480 / 960 / 1440 px WebP variants, each ≤ 250 KiB as `check:performance` enforces,
with `width` / `height` so the page doesn't jump). So each photo is stored as a set of WebP files named by content,
`<id>-<w>.webp` (`.jpg` when made by a browser that can't encode WebP), where `<id>` is the first 24 hex of the sha256 of the largest variant and `<w>` is each width in
480 / 960 / 1440 not above the photo's own width (plus the photo's own width when it is under 1440, as the
manifest does). Uploading the same photo twice is a no-op, and the files can be cached forever. A photo reference
in an era or product is `{ id, width, height, widths: [480, 960, …] }`. Served at `/media/<id>-<w>.webp` with
`Cache-Control: public, max-age=31536000, immutable`. The Render disk snapshot covers KV and photos together.

### Product

```
{
  id,                 // slug, fixed at creation (it is in URLs, carts and orders)
  era,                // era slug
  status,             // 'active' | 'draft' | 'archived'
  name, description, fabric, category,
  priceCents, costCents,
  sizes: ['S', …],
  colors: [{ name, hex, ring?, images: [photoRef…] }],   // first image of the first colour is the cover; ring kept as today
  images?,            // product-level photos for products without per-colour photos, as today
  skus: { '<colour>|<size>': 'SKU' },               // auto-made, editable, unique across the catalog
  continueSelling,    // false: a variant at 0 available is sold out
  lowStockAt,         // default 3
  createdAt, updatedAt
}
```

- SKU default: `<ID>-<COLOUR CODE>-<SIZE>` upper-case (e.g. `99-TEE-BLK-M`); the builder picks the colour code rule.
- Draft and archived products are hidden from shoppers. Archived products stay in KV for order history and stats.
- Removing a colour or size is blocked while any of its variants has On hand or Committed above 0.
- Renaming a colour is allowed only while its variants have Committed = 0; the save moves its `stock:` keys and
  `skus` entries in the same commit. Carts holding the old name get the existing `unknown-item` line status.
- Saving a product sends the `version` it was loaded with. A mismatch returns `409 product-changed` with the current
  product; the page shows what changed and lets the owner save again. Stock is in separate keys, so stock changes and
  product edits never conflict with each other.

### Catalog on disk and the storefront

- A new `server/lib/catalog-store.js` loads `{ eras, products }` from `era:` and `product:` keys into the same shape
  `merge()` produces today (image fields become `/media/<name>` paths). It caches it in memory with its `rev`. Each
  request that needs the catalog reads only `catalog:rev`; if it differs from the cached one, it reloads. This keeps
  any process that shares the SQLite file consistent, and costs one small read per request.
- The public catalog sends photo references with their `/media/` variant paths, width and height. `safeImage()` and
  `imageAttrs()` in `assets/js/images.js` accept them (`/media/<id>-<w>.webp` only) and build `srcset` / `width` /
  `height` from the reference instead of the manifest. The manifest stays for site photos under `assets/img/`.
- `npm run discount` checks era slugs against the target server's era list (from the API), not `data/eras/index.js`.
- `createApp({ data })` keeps accepting injected data for tests. Without it, routes get the catalog from the store.
- **Sold out comes from stock.** `publicView` and `lineStatus` compute availability from `stock:` values: a variant
  is sold out when Available ≤ 0 and the product's `continueSelling` is false. The public output keeps today's
  `soldOut` / `soldOutVariants` fields, now computed, so the storefront code needs no change for that.
- **Quote** caps nothing silently: a line asking for more than Available gets a new line status
  `insufficient-stock` with the `available` count, and `checkoutReady` is false. The cart UI shows it like the
  other line problems.
- `/api/catalog` keeps its `max-age` (≤ 60 s). A shopper may see slightly stale availability; checkout enforces the
  truth.
- The browser fallback in `assets/js/store.js` (`fromStatic`, importing `data/eras/index.js`) is removed: the same
  server serves the page and the API, so it no longer helps.
- Product pages, the sitemap and newsletter emails use the same catalog, so they pick up the new image paths.

### Seeding and migration

- On boot, if `catalog:rev` is missing, the server imports `data/eras/*` (eras and products) in one commit guarded by
  `catalog:rev` being absent, and copies each photo's existing responsive variants (listed in
  `assets/js/image-manifest.js`) into `MEDIA_PATH` under content names. A restart mid-seed can't seed twice; photo
  copies are idempotent by name.
- Seeded stock: **0** for every variant on production and local; **10** per variant on the dev service
  (`ENVIRONMENT=staging`) so checkout can be tested there. Products whose `soldOut` was true are seeded with stock 0
  either way; `soldOut` / `soldOutVariants` are not carried into KV.
- After seeding, `data/eras/` is seed data only. It stays in git for the dev service, fresh local setups and tests;
  the README says plainly that it is not the live catalog. The `TODO` check in `tests/data.test.mjs` is replaced by
  save rules: an era can't be `published` without a tagline, story and hero, and a product can't be `active`
  without a name, price, at least one size, one colour and one photo. Seeded eras are `published`.
- Rollout: deploy while `STATUS=stocking` (it is today) and enter stock in `/inventory`. **The store stays closed
  (`STATUS` not `live`) until WiPay ships** (owner's decision): an unpaid order costs nothing yet holds stock, so
  opening earlier would let anyone reserve the store as sold out. The WiPay rollout sets `STATUS=live`. Everything
  seeds at 0, so stock must be entered before then.

### Stock model

- Per variant: **On hand** (units physically there), **Committed** (units in placed orders not yet picked up or
  cancelled), **Available** = On hand − Committed.
- Movements, each written as an `adj:` record with `{ variant, onHand Δ, committed Δ, reason, note, by, orderId? }`:

| Event | On hand | Committed | `reason` |
|---|---|---|---|
| Owner adjusts stock | ± n | 0 | `received`, `correction`, `damaged`, `returned`, `other` |
| Order placed (today) / paid (WiPay) | 0 | + qty | `order` |
| Order fulfilled (picked up or shipped) | − qty | − qty | `sold` |
| Order cancelled before pickup | 0 (or − qty if "don't restock") | − qty | `cancelled` |
| Refund with restock, after fulfilment | + qty | 0 | `refund-restock` |
| Refund of a line not yet fulfilled | 0 (or − qty if no restock) | − qty | `refund` |

- **Owner adjustments are deltas**, not "set to": the page sends `{ opId, reason, note, changes: [{ variant, delta }] }`
  (`POST /api/inventory/stock`). The server reads each variant with `getEntry`, applies the deltas, and commits with
  version checks on every variant plus the `adj:` records and `op:<opId>`, retrying on a version clash. Two owners
  adding stock at once both land; a retried request finds `op:<opId>` and returns the first result.
- A change that **lowers** On hand is refused with `409 stock-below-committed` if On hand would end below 0 or below
  Committed (units promised to an order can't be written off; cancel or refund the order first). Raising stock is
  always allowed, so a variant oversold through `continueSelling` or a late payment can be restocked.
- Only orders placed after this ships move stock. Each such order carries `stockCommitted: true`; actions on older
  orders change the order only, never stock.

### Checkout

- `submitOrder` gains the stock step inside its existing atomic commit: for each line it checks the variant's
  `stock:` version, checks Available ≥ qty (unless `continueSelling`), and puts Committed + qty, plus the `adj:`
  records. Same commit as the submission, order, day index and email retry job. So:
  - two shoppers can't both get the last unit (the loser's commit fails its version check, re-reads, and gets
    `409 bag-changed` with `insufficient-stock` / `sold-out` lines);
  - a retried checkout (same `checkoutToken` and fingerprint) returns the saved order without touching stock again.
- A cart is at most `MAX_LINES` (50) lines. `kvStore.commit` also checks every key it writes, so a full cart is
  about 105 checks in one commit. The builder confirms this is inside `@deno/kv`'s per-commit check/mutation limits
  and lowers `MAX_LINES` if it isn't.
- `check:load` (CI) places orders on a fresh server, which now seeds 0 stock; it sets stock first.
- **For WiPay (later, recorded here so its plan adopts it):** an `AWAITING_PAYMENT` order commits its units at
  creation with `holdUntil` = now + 15 minutes. Payment success clears the hold and keeps them committed. The
  15-minute job, and any checkout that finds too little stock, releases expired holds (commit guarded on the order
  still being `AWAITING_PAYMENT`). A payment that succeeds after its hold was released and the stock was sold again
  is still accepted, and the owner is alerted once to refund or restock.

### Accounts, sessions and login

Carried over from the old draft, with the role renamed to `owner`:

- Password hash: PBKDF2-SHA256 via WebCrypto, random 16-byte salt, 600,000 iterations. **The CLI generates the
  password** (20 characters from a 58-letter alphabet, from `crypto.getRandomValues`), hashes it locally, sends only
  `{ email, role, salt, hash, iterations }`, and prints the password once. The plaintext never leaves the owner's
  machine and is never stored.
- `POST /api/inventory/login { email, password }`: on success a random 32-byte token, `session:<sha256(token)>`,
  cookie `evincus_inv=<token>; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800`, plus `Secure` over HTTPS.
- Every request resolves the session and re-reads the account; a missing account or a different `epoch` means
  signed out. The role always comes from the account, never the session.
- `POST /api/inventory/logout` deletes the session. `GET /api/inventory/me` → `{ email, role, local }`.
- Wrong email and wrong password: same error, similar time (hash against a dummy record).
- Rate limits (`kvLimiter`): 10 attempts per IP and 5 per email per 15 minutes; blocked attempts logged as
  `login.blocked`.
- Cookie-authenticated `POST` / `PUT` / `DELETE` must carry an `Origin` equal to the request's own origin.

### Permissions

| | Owner | Viewer |
|---|---|---|
| Inventory list, product pages, eras, stock numbers, history | read + edit | read |
| Cost per item, margin, "stock at cost" | yes | hidden (not sent by the API) |
| Orders list and detail | read + actions | read, without customer name, email, phone, customer notes, internal notes |
| Stats | yes | yes |
| Finances, Logs, health | yes | not shown; API returns 403 |

Hiding is done by the API (fields left out of responses), not only by the page.

### Inventory tab

- **List**: search by name or SKU; chips All / Low / Out / Draft / Era; totals: units on hand, committed, stock at
  cost (owners). Each row: cover photo, name, badges (LOW when any variant's Available ≤ `lowStockAt`, `n OUT`,
  DRAFT, ARCHIVED), era, variant count, Available total. Archived products are hidden unless filtered for.
- **Product page**, top to bottom: status (Active / Draft / Archived); photos per colour (upload, drag to reorder,
  remove; first is the cover); details (name, description, fabric, era, category); pricing (price, cost per item,
  live margin "before GCT and fees"); options (colours with name + hex, sizes, "keep selling when out of stock",
  low-stock threshold); stock (one row per colour/size with SKU, On hand and Committed under it, a − / + stepper
  showing Available, the pending delta beside it, one reason + note for the save); history (stock movements, sales
  from orders, field edits, newest first, paged).
- **Save bar** (sticky): "Unsaved: …" summary. Product fields save with the product version check; stock changes
  save as one delta request. One Save button sends both; either part failing is reported separately.
- **New product**: same page, empty, starting as Draft.
- **Eras section** (a button on the list, owners edit, viewers read): eras in `eraOrder` with status (Draft, Live,
  Drops <date>, Ended, Archived) and product count; create (name, slug derived and editable, tagline, story, drops
  at, ends at, hero photo) as Draft, edit, publish and archive, with the same version check. New eras go first;
  owners can move an era up or down. Products of a draft or archived era are hidden from shoppers whatever their own
  status.
- **Field edits** are recorded as `adj:` records with `reason: 'edit'` and a short summary (e.g. "Price 32.99 →
  34.99"), so they show in history and Logs.

### Photos

- **From the page**: the browser decodes the photo with `createImageBitmap(file, { imageOrientation: 'from-image' })`
  and draws each variant width (see Storage layout) on a canvas, encoding WebP, or JPEG where the browser can't
  encode WebP (Safari). Each variant is stepped down in quality until it is ≤ 250 KiB. Re-encoding drops all
  metadata, including GPS. The variants go up in one `PUT /api/inventory/media` (a small multipart or length-prefixed
  body; builder's choice).
- **From the CLI**: `npm run photos -- <era> <product-id> [--color "<name>"] <photo…> [local] [url=<base>]` and
  `npm run photos -- <era> hero <photo>` make the same variants with `sharp` (upright, metadata stripped), upload
  them through the `ADMIN_TOKEN` endpoint, and attach the photo to the product or era.
- **Server checks** (trust boundary): each variant ≤ 250 KiB and the upload ≤ 1 MB; magic bytes say WebP or JPEG;
  widths read from each file's header match the declared set, heights are consistent, nothing above 1440 px wide.
  It stores the bytes as received under the content names and returns the photo reference. Attaching a photo is part
  of the product or era save.
- **Cleanup**: the daily job deletes media files that no era or product references and that are older than 24
  hours (abandoned uploads, removed photos).
- CSP: `img-src` adds `blob:` for upload previews if the page needs it.

### Orders tab

- **Shipping-ready.** The WiPay design adds shipping orders (`fulfillment: { type: 'shipping' }`, sent by hand).
  Statuses are therefore generic from the start, so nothing stored needs migrating when WiPay lands: `READY` exists
  only for pickup; `FULFILLED` shows as "Picked up" for pickup and "Shipped" for shipping. Shipping orders go
  UNFULFILLED → FULFILLED ("Mark shipped"). The `sold` stock movement happens at FULFILLED either way.
- **Order record additions** (older records without them still read):
  - `fulfilmentStatus`: `UNFULFILLED` | `READY` | `FULFILLED` | `CANCELLED` (missing = `UNFULFILLED`).
  - `stockCommitted: true` on orders placed after this ships.
  - Each line gains `sku` and `costCents` (the product's cost at the time of the order; for WiPay orders, refreshed
    at payment).
  - `events: [{ at, type, by, … }]` for the timeline: placed, paid, ready, fulfilled, cancelled, refund, note.
    `by` is the staff account email, or `null` for system events.
  - `refunds: [{ id, at, by, lines: [{ key, qty }], amountCents, taxCents, restock, reason }]`.
- **Day index metadata**: each `day:<date>:<id>` entry (keyed on the **placed** day, written when the order is
  created, whatever its payment status) carries a small summary (`totalCents`, payment status, fulfilment status,
  fulfilment type and pickup location id, units, `placedAt`), updated in the same commit as every order change. The
  list view is one `list` call over the date range, with no per-order reads. No personal data in metadata. The
  WiPay design writes `day:` only once paid, keyed on the paid day; its plan is amended to this rule, and adds
  `paid:<date>:<id>` (on payment) and `refund:<date>:<id>` (on each refund) entries that Finances reads.
- **Retention** (owner's decision: keep the money, delete the people). Today `order:`, `day:` and `submission:` expire
  after 2 years (`ORDER_TTL`). From now on:
  - `order:` and `day:` keys have **no TTL**. Phase 4 rewrites existing ones without their TTL (one-time, idempotent,
    version-checked).
  - The daily job **scrubs personal data** from orders placed more than 2 years ago: `customer`, `payer`, `notes`,
    any shipping address (and its encrypted form once WiPay exists) are removed; `scrubbedAt` is set. Ids, lines,
    totals, GCT, fees, refunds, statuses and events stay, so Finances and stock history keep working. Staff emails in
    `events.by` are staff data and stay.
  - `submission:` keeps its 2-year TTL (it holds a copy of the record with personal data and is only needed for
    checkout retries).
  - The order page shows "Customer details removed after 2 years" on scrubbed orders.
- **Every order write is version-checked.** `updateOrder()` (used by email delivery and retries) today writes the
  whole record without a check, which could undo an owner's action; it becomes a read-modify-commit with a version
  check and retry, changing only its own fields.
- **Views**: Open (default: `PAID` or `NOT_COLLECTED`, and `UNFULFILLED` or `READY`), Ready, Awaiting payment,
  Picked up, Cancelled, All. Filters: date range, pickup location, payment status, product. Search: order id from
  the index; name or phone (owners only) loads the orders in the chosen date range and matches on the server.
- **Detail**: lines with photo, colour/size, SKU, qty × unit price, sale percent; totals (subtotal, and GCT and fee
  once WiPay exists, total); cost of goods (owners); customer and pickup (owners); WiPay transaction id, paid time and
  refund-window countdown (WiPay orders); timeline.
- **Actions** (owners): `POST /api/inventory/orders/<id>/actions { opId, version, action, … }`, where `action` is
  `ready`, `fulfilled`, `cancel { restock }`, `refund { lines, amountCents, restock, reason }`, or `note { text }`.
  Each is one commit: version check on the order, the stock changes from the movement table, `adj:` records, the
  updated order and day-index metadata, and `op:<opId>`. A version mismatch returns `409 order-changed` with the
  current order.
- **Allowed transitions**: pickup UNFULFILLED → READY → FULFILLED; shipping UNFULFILLED → FULFILLED; UNFULFILLED
  or READY → CANCELLED. No way back from FULFILLED or CANCELLED. Refunds only on paid orders; their total can't exceed the amount charged. Default refund
  amount: the chosen lines' items plus their GCT; the processing fee is never refunded. Cancel on a paid order shows
  "refund it in the WiPay dashboard, then record the refund here".
- Customer notes stay in the existing `notes` field; internal notes are `note` events, owners only.

### Stats

- Period: Today, 7 days, 30 days, Custom; Jamaica days. Tiles: **Sales** (order value of placed orders, labelled
  "Sales (order value)", never "Revenue"), Orders, Units sold, Average order; each with change vs the previous
  period of the same length.
- Sales per day: single-series bar chart, our own SVG, one hue, per-bar hover tooltip, "Show as table" view.
- Best sellers by units (per product; switch to per era, colour, size), sizes sold, pickup split (by location, plus
  shipping once it exists), running-low list
  (variants at or under `lowStockAt`, worst first).
- Counts orders that are placed and not cancelled (`NOT_COLLECTED`, `PAID`, refunded variants); excludes
  `AWAITING_PAYMENT`. Refunded quantities are subtracted from units.
- Computed on request from the day index and the orders in the period. Results for a period are cached in memory
  until any order changes.

### Finances (owners; switches on with WiPay)

- Counts only money actually charged (`PAID`, `REFUNDED`, `PARTIALLY_REFUNDED`), by paid day; refunds by refund day.
- Until any paid order exists, the tab shows: "No payments collected yet. Order value is in Stats."
- Rows, with the mockup's numbers as the worked example (they add up):
  - Revenue = Σ charged totals.
  - Refunds = Σ refund amounts.
  - Net revenue = Revenue − Refunds.
  - GCT owed = Σ `taxCents` − Σ refunded `taxCents`.
  - WiPay fees = Σ round(charged total × `PROCESSING_FEE.bps` / 10000), i.e. 4.83% of each full charge, never
    reduced by refunds.
  - Cost of goods = Σ line `costCents` × (qty − restocked refunded qty). Lines without `costCents` count as 0 and
    the tab shows "cost missing on n items".
  - **Profit** = Net revenue − GCT owed − WiPay fees − Cost of goods; margin = Profit / Net revenue.
- Best sellers by profit (units, revenue, profit per product); refunds list (order, reason, amount); by-month table
  (revenue, GCT owed, profit); period: this month, last month, year, custom.
- CSV download: one row per paid order (id, paid at, subtotal, GCT, fee, total, cost of goods, refunded) and one per
  refund. No customer personal data.
- Built in the WiPay phase, when `data/fees.js` and the payment fields exist.

### Logs and health (owners)

- Saved to KV (30-day TTL), best-effort, never slowing or failing the request (`waitUntil`): `error` lines;
  `request` lines with status ≥ 500; `warn` lines other than `request`; and the events `login.ok`, `login.failed`,
  `login.blocked`, `account.added`, `account.removed`, `sales.updated`, `era.saved`, `product.saved`,
  `stock.adjusted`, `media.uploaded`, `order.placed`, `order.ready`, `order.fulfilled`, `order.cancelled`,
  `order.refunded`, `inventory.pulled`.
- Staff identity goes in an `account` field filled only from a stored account (session or CLI action); for failed
  and blocked logins it is set only when the typed email matches an account. `email` / `name` stay reserved for
  customers and keep being stripped.
- `GET /api/inventory/logs?level=&kind=&before=`, newest first, paged. Filters by level and kind.
- Health panel: deployed commit, KV check (as `/api/health`), disk and scheduler status (`env.OPERATIONS`), free disk
  space, media folder size, last job run, emails waiting to retry, last daily summary sent, catalog `rev`.

### CLI

All use `ADMIN_TOKEN` as a Bearer token against `/api/admin/*` (the existing `denied()` / `sameToken()` check),
target production by default, and take `local` or `url=<base>` like `npm run discount`.

- `npm run add-viewer <email> [owner] [local] [url=<base>]`: creates the account (viewer unless `owner`) or, if it
  exists, issues a new password and bumps `epoch` (signs that person out everywhere). On replace, the role is kept
  unless `owner` or `viewer` is given. Prints the generated password once.
- `npm run remove-viewer <email> …`, `npm run list-viewers …` (email, role, created, last sign-in).
- `npm run new-era <slug> "<Name>" …`: creates the era on the target as `draft`, first in `eraOrder`. The owner
  fills it in and publishes it from `/inventory`. Refuses a slug that already exists.
- `npm run photos …`: as in Photos.
- `npm run inventory:pull [url=<base>]`: downloads eras, products, stock and photo list from production
  (`GET /api/admin/export`, production `ADMIN_TOKEN`), fetches any photo file the local server lacks, and loads it
  into the running local server through `PUT /api/admin/import` (local `ADMIN_TOKEN`, the `.env` value). The two
  tokens come from separate variables (builder names them, e.g. `PROD_ADMIN_TOKEN` alongside `ADMIN_TOKEN`). The import endpoint answers `404` unless `ENVIRONMENT=development`
  and the request comes from loopback, so it can never replace production data. Orders, accounts and logs are not
  copied. Rerunning it gives the same result.

### Local and remote access

- Same page, same code. `evincus.shop/inventory` edits production. `localhost:8000/inventory` edits the local
  `.kv.sqlite3` and `.media/`, as a sandbox; the owner creates a local account with `npm run add-viewer <email> owner
  local`.
- Nothing pushes local data to production.
- The page shows a "LOCAL" badge in its header when `/api/inventory/me` reports `local: true`.

### Status gate and static serving

- `/inventory`, `/api/inventory/*`, `/api/admin/*` and `/media/*` are exempt from the `STATUS` 503 gate (API and
  static), so the owner can stock the store while it is closed.
- `server/static.js` maps `/inventory` to `inventory.html` and serves `/media/<name>` from `MEDIA_PATH` (names
  matching `^[0-9a-f]{24}-[0-9]{3,4}\.(webp|jpg)$` only). The page has `<meta name="robots" content="noindex">` and
  `robots.txt` disallows `/inventory`.

### Page

- `inventory.html` at the repo root, `assets/css/inventory.css`, `assets/js/inventory.js` plus `inventory-*.js`
  modules per tab. Store look: `--ink` background, `--bone` text, `--ash` / `--char` cards, `--hazard` accent.
- Charts are plain SVG drawn by our own code, following the dataviz skill (one hue per single-series chart, hover
  tooltips, table view, status colours always with an icon and label).
- Every state-changing request gets a `crypto.randomUUID()` `opId`, created when the owner presses the button and
  reused on retry.

## Phases

The plan should deliver in this order, each phase shippable with tests passing:

1. Catalog on disk: KV layout, catalog store with `rev` cache, media store and `/media/`, seeding, storefront and
   quote reading stock (sold out derived, `insufficient-stock`), checkout committing stock, removal of the static
   fallback.
2. Accounts, sessions, login, CLI `add-viewer` / `remove-viewer` / `list-viewers`, `/inventory` shell with tabs,
   status-gate exemptions.
3. Inventory tab: list, product page, stock adjustments, history, eras, photo uploads; CLI `new-era` and `photos`
   retargeted.
4. Orders tab: record additions, day-index metadata, list, detail, actions.
5. Stats.
6. Logs and health.
7. `inventory:pull` (export / import).
8. With WiPay (separate plan, amended): holds, paid revenue, Finances.

## Testing

`node --test` coverage at least for: stock deltas and the movement table; refusing On hand < Committed; concurrent
checkouts for the last unit (one wins); checkout retry not committing twice; order actions applied once per `opId`
and refused on a stale version; legacy orders never moving stock; product save conflicts; colour rename moving
stock; seeding exactly once; catalog `rev` reload; media checks (type, size, dimensions, name pattern); auth
(hashing, sessions, epoch, rate limits, Origin check); viewer field hiding on every endpoint; status-gate
exemptions; stats and finances arithmetic (the mockup's worked example); import endpoint refused outside local
development; CLI argument parsing; responsive photo variants (widths, size cap, names) and `safeImage` accepting
`/media/`; the 2-year personal-data scrub (removes only personal fields, runs once per order) and the one-time TTL
rewrite; `updateOrder()` not overwriting a concurrent owner action.

## Left to the builder

- Exact file split in `server/` (e.g. `lib/catalog-store.js`, `lib/stock.js`, `lib/media.js`, `lib/accounts.js`,
  `lib/stats.js`, `routes/inventory.js`) following existing patterns.
- Exact endpoint paths beyond those named, page sizes, empty and loading states, error copy.
- SKU colour-code rule.
- How the CLI scripts share option parsing with `scripts/discount.mjs`.
- Whether `scripts/restore-check.mjs` also checks `MEDIA_PATH`.
- README: "Inventory" section (CLI commands, roles, local vs live, rollout steps) and the note that `data/eras/` is
  seed data.
- Mark `2026-10-18-admin-dashboard-design.md` as replaced by this document.

## Owner decisions

- Two roles: viewers read-only, owners edit.
- Five tabs: Inventory, Orders, Stats, Finances, Logs. Finances: revenue, profit after fees and GCT, best sellers,
  refunds, with cost per item per product.
- Stock editing: Shopify-style variant list with − / + steppers (mockup option B).
- Eras move to the disk; `npm run new-era` writes to the server's disk.
- Build inventory before WiPay; the store stays closed until WiPay ships.
- Order records: amounts kept permanently, customer details removed after 2 years.

## Calls made in design (owner can override)

- Prod disk is the single source of truth; local is a sandbox; `inventory:pull` is one-way.
- Photos as content-named files on the disk, not in KV; browser-side conversion, so no new server dependency.
- Stock adjustments are deltas; On hand can't go below Committed.
- Viewers see orders without personal data, and never cost or profit.
- Stats says "Sales (order value)"; only Finances says "Revenue".
- Cancel releases committed units by default; refunds are recorded here, issued in the WiPay dashboard.
- Logs kept 30 days; history (`adj:`) kept forever.
- No customer emails from order actions; no compare-at price; no hard delete.
- Seed stock 0 (prod, local) and 10 (dev service).
- Photos stored as responsive WebP sets (480 / 960 / 1440, ≤ 250 KiB each, JPEG from Safari), matching today's
  storefront images.
- Order statuses are generic (`FULFILLED` = picked up or shipped) so WiPay's shipping orders need no migration.
- `day:` index keyed on the placed day for every order; Finances gets its own `paid:` and `refund:` indexes.
- Lowering stock below Committed is refused; raising it is always allowed.
- `updateOrder()` becomes version-checked so email retries can't undo an owner's action.

Mockups (local only, `.superpowers/` is git-excluded): `.superpowers/brainstorm/1990-1793148163/content/`
`inventory.html`, `product.html`, `orders.html`, `stats-finances.html`.
