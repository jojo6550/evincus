# Admin dashboard (`/login-admin`): design

Date: 2026-10-18. Status: draft for owner approval.

## Intent

The owner wants one private page, `evincus.shop/login-admin` (and `localhost:8000/login-admin`), that answers "how is
the store doing?" at a glance: order value, breakdowns by era, product, colour and size, and charts. People the owner
trusts can be given read-only access to the numbers. The same page gives the owner a point-and-click way to do what
`npm run new-era`, `npm run photos` and `npm run discount` do today, and shows logs and sign-in/management activity.

Accounts are created only by the owner, from their own machine, with an npm command. Nobody can sign up on the site.

## Goals

1. `/login-admin` serves a sign-in page (email + password). Once signed in, the same URL shows the admin app.
2. Two roles:
   - **viewer**: Dashboard tab only.
   - **admin** (the owner): Dashboard, Logs, Viewers, Sales, and Eras (Eras only on localhost; see below).
3. **Dashboard** (approved mockup: `.superpowers/brainstorm/*/content/dashboard.html`):
   - Period picker: Today, 7 days, 30 days, All time. Days are Jamaica days (UTC-5, no DST), matching `dayKey`.
   - Headline tiles: Order value, Orders, Units, Average order value, each with change vs the previous period of the
     same length (not shown for All time).
   - Chart: order value per day.
   - Breakdowns (bar + table): by era, by product, by colour/size, delivery vs pickup.
   - Recent orders list.
   - Phone: tabs in a bottom bar. Desktop (≥ 768px): sidebar.
4. **Logs** (admin): errors and warnings, sign-in activity (success, failure, blocked), admin actions (viewer
   added/removed, sales changed, era saved), filterable by level and kind. **System health** panel: deployed commit,
   KV check (same as `/api/health`), last cron run time, count of customer confirmation emails still pending retry,
   last daily summary sent.
5. **Viewers** (admin): list accounts (email, role, created, last sign-in) and remove one. Adding stays CLI-only.
6. **Sales** (admin): GUI for `npm run discount`: list running/scheduled sales, start one (eras or all, days or end
   time, percent, optional label, optional start), end one or all. Works on the live site (sales already live in KV).
7. **Eras** (admin, **localhost only**; approved mockup: `.superpowers/brainstorm/*/content/eras.html`):
   - Era list with status (Live / Drops <date> / Ended) and count of `TODO`s left.
   - New era: name (slug derived, editable), tagline, story, drops at, ends at, hero photo. Same result as
     `npm run new-era` (folder, `era.js`, `img/`, both lines in `data/eras/index.js`).
   - Edit era fields and its products: name, price, category, fabric, sizes, colours (name + hex), sold out, sold-out
     variants. Add product.
   - Photos per product or per colour: upload, reorder, remove. Uploads go through the same conversion as
     `npm run photos` (upright, fit 1800 px, webp under 500 KB, next free kebab name).
   - "Unshipped changes" box: files changed under `data/` per `git status --porcelain data/`, and a **Run tests**
     button that runs `node --test` and shows pass/fail plus output.
8. **CLI** (owner's machine only, uses `ADMIN_TOKEN` exactly like `npm run discount`, same `local` and `url=<base>`
   plain-word options):
   - `npm run add-viewer <email> [password] [admin|viewer] [local] [url=<base>]`: creates the account (role
     `viewer` unless `admin` is given), or replaces the password if the email exists. On replace, the role is kept
     unless `admin` or `viewer` is given explicitly, so a password change can't demote the owner. If `password` is
     left off, prompt for it without echo.
   - `npm run remove-viewer <email> [local] [url=<base>]`
   - `npm run list-viewers [local] [url=<base>]`

## Non-goals

- **Ratings/reviews.** None exist in the store; out of scope.
- **Traffic, views, conversion.** Not tracked; out of scope.
- **Collected revenue.** No payment is collected (`paymentStatus: NOT_COLLECTED`). The page shows **order value**
  and must label it that way ("Order value", never "Revenue").
- **Editing eras on the live site.** The catalog is files in git, deployed only via `prod` after CI. The live
  `/login-admin` has no Eras tab and the era endpoints don't exist there.
- Deleting an era or moving a product between eras from the page (stay manual, as in README).
- Committing, pushing or deploying from the page. The owner still runs `dev → main → prod`.
- Self-service sign-up, password reset, email invites. Forgotten password: owner reruns `add-viewer`.
- Adding viewers from the web page.

## Anti-goals (failure even if it "works")

- Anything that changes checkout, order placement, emails or sales behaviour for shoppers.
- A way to create accounts or reach admin data without the owner's `ADMIN_TOKEN` or a valid session.
- Customer PII in logs (existing `redact` rule holds for every new log line).
- Era file writes reachable from anything other than the owner's local dev server.
- Calling order value "revenue".

## Constraints (from the existing project)

- Vanilla ES modules, no build step, no new runtime dependency. `sharp` is a dev dependency and is only used by the
  local-only photo path (as `scripts/photos.mjs` does today).
- CSS only in `assets/css/`, JS only in `assets/js/`. No `style=` attributes, no inline `<style>`/`<script>`.
- Mobile first: base CSS for ~375px, scale up with `min-width` queries.
- `server/` uses only web-standard `Request`/`Response`. Routes go in the `ROUTES` table in `server/index.js`.
- KV is the existing `env.ORDERS` store (`get`/`getEntry`/`put`/`delete`/`list`/`commit`); rate limiting via
  `kvLimiter`. KV has no CAS outside `commit` checks: account and sales writes that must not clobber use `commit`.
- Static files: `server/static.js` serves only `/*.html`, `/assets/`, `/data/`. `/login-admin` must be mapped to a
  new `login-admin.html` explicitly. `.html` pages are `no-cache`.
- Logs are JSON lines with PII stripped (`server/lib/log.js`).
- Every change ships through `npm test`; new logic gets `node --test` tests in `tests/`.
- Render sets `ENVIRONMENT=production`; local `.env` sets `ENVIRONMENT=development`.

## Decided how

### Accounts and passwords

- KV key `account:<lowercased email>` → `{ email, role: 'viewer'|'admin', salt, hash, iterations, epoch, createdAt,
  lastLoginAt }`.
- Hash: PBKDF2-SHA256 via WebCrypto (`crypto.subtle`, available in Node), random 16-byte salt, 600,000 iterations.
  The CLI hashes locally and sends `{ email, role, salt, hash, iterations }`, so the plaintext password never leaves
  the owner's machine. Password minimum length 12.
- CLI endpoints authenticate with `Authorization: Bearer <ADMIN_TOKEN>` using the existing `denied()` /
  `sameToken()` check in `server/routes/admin.js`: `PUT /api/admin/accounts` (add or replace), `DELETE
  /api/admin/accounts/<email>`, `GET /api/admin/accounts`.
- Replacing a password increments `epoch`, which ends that account's other sessions. Removing deletes the key.

### Sessions

- `POST /api/admin/login { email, password }`: on success, create a random 32-byte token, store
  `session:<sha256(token)>` → `{ email, epoch, expiresAt }` with a 7-day TTL, and set cookie
  `evincus_admin=<token>; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800`, plus `Secure` when the request is HTTPS.
- Every admin request resolves the session, then re-reads the account: missing account or different `epoch` means
  signed out. The role always comes from the account, never from the session.
- `POST /api/admin/logout` deletes the session and clears the cookie.
- `GET /api/admin/me` → `{ email, role, local }`, used by the page to choose sign-in form vs app and which tabs show.
- Wrong email and wrong password give the same error and take similar time (hash against a dummy record when the
  account doesn't exist).
- Rate limits with `kvLimiter`: 10 attempts per IP per 15 minutes, 5 per email per 15 minutes. Blocked attempts are
  logged as `login.blocked`.
- Cookie-authenticated `POST`/`PUT`/`DELETE` requests must carry an `Origin` equal to the request's own origin
  (CSRF guard on top of `SameSite=Strict`).

### Sales tab

- The existing `GET`/`PUT /api/admin/sales` endpoints accept **either** the Bearer `ADMIN_TOKEN` (CLI, unchanged) or
  an admin session. The GUI builds sales with the same rules as `scripts/discount.mjs` (`makeSale`, `addSale`,
  `endSale`, `isSale`) and saves with the same `version` check; on `409 sales-changed` it reloads and asks the owner
  to retry.

### Stats

- `GET /api/admin/stats?period=today|7d|30d|all` (viewer or admin). Server walks `day:<date>:<id>` keys for the
  period (and the previous period for comparisons), loads each `order:<id>`, and aggregates.
- Order value = sum of `totalCents`. Units = sum of line `qty`. Item value = `qty × unitCents` (sale price at the
  time of order, already stored on the line).
- Era of a line: look up `line.id` in the current catalog (legacy PayPal lines have only `key`; take the id from
  `key`'s first `|` part). Products no longer in the catalog go under "Removed products".
- Include `PLACED` orders and legacy PayPal `COMPLETED` orders. Every number is order value, not collected payment.
- Recent orders: last 20 in the period, with time, item summary, total and delivery/pickup. **Admin** also sees the
  customer's name; **viewers** never see customer name, email, phone or address.

### Logs

- `createLogger` additionally saves to KV only:
  - `error` lines (any event), and `request` lines with status ≥ 500;
  - `warn` lines whose event is **not** `request` (so bot 404s, 401s, 429s and `bag-changed` 409s are never saved;
    anonymous traffic can't fill the disk). *(Builder-check call.)*
  - these named events: `login.ok`, `login.failed`, `login.blocked`, `account.added`, `account.removed`,
    `sales.updated`, `era.saved`, and `order.placed` (the event real orders log under `PAYMENT_MODE=none`, in
    `server/routes/checkout.js`; `order.created` is the PayPal-only intent event and is saved only in PayPal mode).
  Key `log:<ISO ts>:<random>`, 7-day TTL. Saving is best-effort and must never fail or slow the request it logs
  (fire-and-forget via `waitUntil`).
- **Account identity in logs** *(builder-check call)*: `redact()` keeps dropping `email`/`name` fields, which stay
  reserved for customer data. Staff identity goes in a separate `account` field holding the account's email, and is
  only ever filled from a **stored account** (signed-in session, or an `account.*` CLI action). For `login.failed`
  and `login.blocked`, `account` is set only when the typed email matches an existing account; otherwise the line
  says `account: null` (`unknown`), so a customer's address or a mis-pasted password typed into the email box is
  never logged. Document in `log.js` that `PII_KEYS` covers customers, and `account` is staff-only.
- `GET /api/admin/logs?level=&kind=&before=` (admin): newest first, paged.
- Health panel: `/api/health` data, plus a `cron:lastRun` KV key the scheduled job writes each run, plus the count
  of `email-retry:` keys, plus the latest completed daily-summary marker.

### Eras tab (local only)

- Era endpoints live under `/api/admin/local/…` and answer `404` unless **all** hold: `ENVIRONMENT=development`,
  the request's socket address is loopback, and the `Host` is `localhost` or `127.0.0.1`. They also require an admin
  session.
- They write files with the existing script code: `scripts/new-era.mjs` (`template`, index.js markers) and
  `scripts/photos.mjs` (`toWebp`, `nextNames`, `kebab`). Uploads arrive as the raw file body (capped at 25 MB per
  photo), are written to a temp file, converted, then placed.
- Saving era/product fields regenerates that era's `era.js` from the edited data in the same layout the files use
  today (header comment, `era`, `products`). Hand-written comments inside the products array are not kept; the page
  says so before the first save of an era that has them.
- `POST /api/admin/local/test` runs `node --test` in the repo root and returns exit code and output (one run at a
  time; a second request while one runs gets `409`).
- `GET /api/admin/local/changes` returns `git status --porcelain data/`.
- Era saves are logged as `era.saved` to the **local** KV (they never reach production logs, which is expected).

### Page

- `login-admin.html` at repo root, `assets/css/admin.css`, `assets/js/admin.js` (plus `admin-*.js` modules as
  needed). Static server maps `/login-admin` to it. Add `<meta name="robots" content="noindex">`.
- Visual style follows the store's dark look (`assets/css/index.css`): black background, light text, grey cards.
- Charts are plain SVG/CSS drawn by our own code (no chart library). Follow the dataviz skill for colour, axes and
  accessibility (each chart has a text/table equivalent).

## Left to the builder

- Exact file split of new server code (`server/routes/admin.js` vs new `server/lib/accounts.js`, `stats.js`,
  `local-eras.js`, etc.), following existing patterns.
- How the CLI scripts share arg/env/token parsing with `scripts/discount.mjs` (reuse its exports where they fit).
- Exact log page size, chart sizes, empty states, loading states and error copy.
- Previous-period comparison format.
- Test layout, as long as auth, sessions/epoch, rate limits, stats aggregation, the local-only guard, era file
  writing and the CLI arg parsing are covered.
- README: add a short "Admin page" section (CLI commands, roles, local-only Eras tab).
- Add `.superpowers/` to `.gitignore`.
