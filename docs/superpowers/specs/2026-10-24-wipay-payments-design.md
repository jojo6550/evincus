# WiPay payments: design

Date: 2026-10-24. Status: draft for approval.

## Intent

Checkout currently places a pickup order and charges nothing (`paymentStatus: NOT_COLLECTED`). Evincus needs real
card payments through WiPay (Jamaica platform), plus the customer details the owner needs to ship orders by hand.

The refund policy (`policies.html#refund`) shapes the design: the customer has 24 hours from *purchase completed*,
timed by the receipt, and refunds go back to the original payment method, issued by hand. So every paid order must
record when WiPay confirmed payment and the WiPay transaction ID, and the receipt must show both.

## Goals

1. Customer taps Pay, goes to WiPay's hosted payment page, pays by card, and comes back to the store.
2. An order counts as paid only after the server verifies WiPay's response hash. Nothing the browser says is trusted.
3. Every payment path is idempotent and race-free. Double clicks, refreshes, a replayed return URL, two tabs and
   concurrent requests can never mark an order paid twice, send two receipts, or lose a payment that did happen.
4. Checkout collects first name, last name, email and optional phone, then the customer chooses pickup (pickup
   location) or shipping (postal address anywhere in the world).
5. Customer details are stored in the existing Render disk database and encrypted inside it.
6. Receipt email after payment, carrying paid time (Jamaica time), WiPay transaction ID and amount.
7. Policies page updated so it no longer says no payment is collected.
8. The cart shows the full breakdown before checkout: subtotal, GCT, WiPay processing fee, total. The total in the
   cart is exactly what WiPay charges.
9. Visitors can view prices in their own currency (detected from the browser, changeable), as estimates. Checkout
   always charges USD.

## Non-goals

- Refunds through the site. The owner refunds in the WiPay dashboard (policy says requests are handled by hand).
- Shipping logistics through the site: no rates, shipping charge, labels or tracking. A shipping order pays the
  order total only; the owner contacts the customer about shipping cost and timing and ships by hand.
- WiPay webhooks in this version. The `payment.*` event payload is undocumented (its docs page 404s) and merchant
  webhook testing needs WiPay to set it up. The design leaves a single `confirmPayment` function the webhook can call
  later. Follow-up, not forgotten (see Risks).
- WAPI transaction retrieve (needs a separate WAPI key). Possible later cross-check.
- Moving to Postgres or any new database service.
- Saved cards, accounts, partial payments, charging in any currency other than USD.
- IP geolocation. Country comes from the browser's language settings, so no visitor IP goes to a third party.

## Anti-goals (would be a failure even if it "works")

- An order marked paid from query-string values without a verified hash.
- A customer charged twice for one order without the owner being told.
- A payment that landed in WiPay with no matching order record.
- Personal details (name, email, phone, address, notes) in plaintext on disk, in logs, in alerts or in error pages.
- The WiPay API key or the encryption key reaching the browser, a log line or the repo.
- Store maintenance mode (`STATUS` not `live`) dropping a payment confirmation for a customer mid-payment.

## Decided by the owner

| Decision | Choice |
| --- | --- |
| Database | Existing Deno KV in SQLite on the Render persistent disk (`KV_PATH=/var/data/kv.sqlite3`) |
| Fulfillment | Customer chooses pickup or shipping at checkout. Shipping cost and timing are arranged by the owner after purchase |
| Address scope | Anywhere: country picker, free-form state/province, optional postal code |
| WiPay fee | Customer pays it, shown as a cart line before checkout. WiPay Basic Free plan: 4.20% + 15% GCT on the fee = 4.83% |
| Tax | GCT 15%, added on top of listed prices, on every order |
| Currency | Converted prices are estimates for any country; checkout always charges USD |
| Encryption | Yes: customer details encrypted in the database with a new secret key |
| Fee on refunds | WiPay's processing fee is non-refundable; a refund covers the order total |
| Payment flow | Hosted page, paid only once WiPay confirms, receipt with transaction ID and paid time, refunds by hand in the WiPay dashboard |
| Phone | Optional |

## WiPay facts this design relies on

From docs.wipayfinancial.com (Payments API, Transaction Response, Platforms and Environments, Testing, Hosted
Checkout Flows), read 2026-10-24.

- Request: `POST {base}/plugins/payments/request`, JSON body, header `Accept: application/json`. No auth header.
  Base: live `https://jm.wipayfinancial.com`, sandbox `https://jmsb.wipayfinancial.com`.
- Required fields: `account_number` (integer), `country_code` (`JM`), `currency`, `environment` (`live`|`sandbox`),
  `fee_structure`, `method` (`credit_card_co`; legacy `credit_card` is deprecated), `order_id`
  (`^(?![_-])[a-zA-Z0-9_-]+(?<![_-])$`, recommended max 16), `origin` (same regex, 1 to 32), `response_url`
  (max 255), `total` (2 decimals), `email` (max 50, must differ from the merchant's email).
- Optional prefill: `fname` (max 30), `lname` (max 30), `phone` (E.164 `^\+[1-9]\d{1,14}$`), `country` (ISO
  alpha-2), address fields, `data` (max 4096, echoed back).
- 200 response: `{ url, message: "OK", transaction_id }`. Not payment confirmation.
- Hosted session expires after 3 minutes.
- Return: browser `GET response_url?...` with `status` (`success`|`failed`|`error`), `transaction_id`, `order_id`,
  `total` (customer-facing, includes fee, do not trust), `currency`, `date`, `message`, `card`, `data`, and `hash`
  on success only.
- Verification: `hash = md5(transaction_id + original_total + api_key)`, lowercase hex, `original_total` being the
  total *we sent*, formatted to exactly 2 decimals.
- `transaction_id` format: `[SB-]<1-99>-<WiPay user id>-<order_id>-<YYYYMMDDhhmmss>`.
- Sandbox: `account_number` `1234567890`, API key `123`, `environment=sandbox`. USD test card `4242424242424242`
  succeeds, `4000000000000002` declines.

## How it works

### Data model (existing KV store, `env.ORDERS`)

Order record `order:<id>` changes:

- `status`: `AWAITING_PAYMENT` until paid, then `PLACED`.
- `paymentStatus`: `UNPAID` then `PAID`. Legacy records keep `NOT_COLLECTED` and must still read.
- `taxCents`, `feeCents`, plus the `taxBps`/`feeBps` used, next to the existing `subtotalCents`; `totalCents` is
  their sum. Legacy records have neither (read as 0).
- `payment`: `{ provider: 'wipay', transactionId, paidAt, chargedTotal, currency }` once paid. `paidAt` is the
  server time the hash was verified; it is the "purchase completed" time for the refund window. `chargedTotal` is
  WiPay's reported total, stored as informational only (the hash does not cover it). It should equal `totalCents`;
  a difference logs `payment.total_mismatch`.
- `pii`: encrypted envelope (see Encryption) holding `customer` (`firstName`, `lastName`, `email`, `phone`),
  `address` (`line1`, `line2`, `city`, `region`, `postalCode`, `country`) and `notes`. The plaintext `customer`,
  `payer` and `notes` fields go away on new records.
- `fulfillment`: `{ type: 'pickup', location }` (plaintext: store data) or `{ type: 'shipping' }`, whose address
  lives only in the encrypted `pii.address`. A pickup order has no address.

New keys:

- `payment-attempt:<attemptId>`: `{ orderId, totalCents, currency, url, wipayTransactionId, createdAt, state }`,
  `state` being `open`, `failed` or `paid`. TTL 2 years.
- `fx:latest`: `{ fetchedAt, updatedAt, rates }` exchange-rate cache (see Currency display).
- `wipay-txn:<transaction_id>`: `{ orderId, attemptId, duplicate: boolean }`. Written once per WiPay transaction.
  This is the dedupe key: its absence is checked in the same atomic commit that marks the order paid.

`attemptId`: 16 characters, `[A-Za-z0-9]`, random, used as WiPay's `order_id`. It is not the order ID because ours
(`EV-<uuid>`, 39 chars) is over WiPay's recommended 16.

Retention: an order that never reached WiPay, and its submission, expire after 7 days. Once an attempt exists (the
customer reached WiPay), the order and submission get the existing 2-year `ORDER_TTL`, so a payment WiPay holds always
has an order behind it. Marking paid also refreshes both to 2 years, so a resent place-order with the same checkout
token can never overwrite a paid order. The submission record keeps its fingerprint but drops the full record copy
once paid (or encrypts it the same way; builder's choice) so personal data is not stored twice in plaintext.

### Flow

1. **Place order.** `POST /api/orders` keeps its current idempotency (checkout token, fingerprint, atomic
   `submitOrder`). It now creates the order `AWAITING_PAYMENT`/`UNPAID`, writes no receipt retry job and no day
   index, and does not send a receipt. Validation adds the new fields (below).
2. **Start payment.** New `POST /api/orders/:id/pay`. Rate-limited per IP.
   - Order missing: 404. Already `PAID`: return `{ paid: true }` (client goes to the confirmation).
   - An `open` attempt for this order created under 150 seconds ago: return its `url` (double click, refresh).
   - Otherwise: generate an `attemptId`, call WiPay, then one atomic commit that writes the attempt and points the
     order at it (`order.attemptId`), checked against the order version read at the start. If the commit loses a
     race, re-read and return the winning attempt's `url`; the losing WiPay session is simply never shown.
   - WiPay request: `account_number`, `country_code: 'JM'`, `currency: 'USD'`, `environment`,
     `fee_structure: 'merchant_absorb'`, `method: 'credit_card_co'`, `order_id: attemptId`, `origin: 'evincus'`,
     `response_url: ${API_URL}/api/payments/wipay/return`, `total` from `order.totalCents` as `"12.34"` using
     integer math, `email`, `fname`, `lname`, `phone` only when it normalizes to E.164, `country`, `version` from
     `COMMIT_SHA` truncated to 16. Address is not sent (WiPay's `state` wants ISO 3166-2 codes; our region is
     free-form). Timeout 10 s. A non-200 or missing `url`: 502 `payment-unavailable`, nothing saved.
3. **Pay.** Browser `location.assign(url)`. Card details only ever touch WiPay.
4. **Return.** New `GET /api/payments/wipay/return`. Always ends in a `303` to the store
   (`/?checkout=paid&order=<id>` or `/?checkout=failed&order=<id>`), never shows WiPay's raw values.
   - Look up `payment-attempt:<order_id>`. Unknown attempt: log, redirect to `/?checkout=failed`.
   - `transaction_id` must match the format and contain `-<attemptId>-`.
   - `status=success`: compute md5 over `transaction_id + total-we-sent + WIPAY_API_KEY`, constant-time compare
     with `hash`. Mismatch: log `payment.hash_mismatch` (no PII), alert owner, redirect failed. Match: call
     `confirmPayment`.
   - `failed`/`error`: mark the attempt `failed` (only if still `open`), redirect failed. The order stays unpaid and
     the customer can pay again, which makes a new attempt.
5. **`confirmPayment(orderId, attempt, transactionId, reportedTotal, currency)`**, loop up to the store's rounds:
   - `wipay-txn:<transactionId>` exists: already handled. Return its result (idempotent replay of the return URL).
   - Order already `PAID` by a different transaction: commit `wipay-txn` with `duplicate: true` (checked absent);
     if that commit wins, alert the owner once: order, both transaction IDs, "refund one in the WiPay dashboard".
   - Else one atomic commit, checks: order version unchanged, `wipay-txn` absent. Puts: order `PLACED`/`PAID` with
     `payment`, 2-year TTL; `wipay-txn`; attempt `state: paid`; the `day:` index on the paid day (so the daily
     summary lists paid orders); the receipt `email-retry:` job. A lost race re-reads and re-decides.
   - After the commit, kick off the receipt with the existing `sendOrderEmails` in `waitUntil`. Its Resend
     idempotency key `${id}-customer` already stops a double send.
6. **Back on the store.** The client reads `checkout`/`order` from the URL, then `GET /api/orders/:id/status`
   (returns `{ status, paymentStatus, totalCents, paidAt, transactionId }`, no personal data). Paid: show the
   confirmation, remove the ordered items from the cart, clear the pending checkout. Not paid: reopen the bag on the
   pay step with "Payment didn't go through" and a Pay again button, which calls step 2 for the same order.
   The query string is then removed with `history.replaceState`.

### Store status gate

`/api/payments/wipay/return` and `/api/orders/:id/status` must be exempt from the `STATUS` 503 gate in
`server/index.js`, like health and newsletter confirm. A customer already on WiPay's page when the store goes into
maintenance must still be confirmed.

The return redirect lands on a small `order.html` confirmation page (not `index.html`, which needs gated catalog
routes). `order.html` is exempt from the static gate in `server/static.js`, reads `/api/orders/:id/status`, shows
paid or "payment didn't go through" with a link back to the cart, and clears the paid items from the cart. With the
store open, its link goes back to `/` and the bag reopens on the pay step for "Pay again". (Builder's call on exact
markup; it follows `newsletter.html`, which is already an exempt standalone page.)

### Payments switched off

If `WIPAY_ACCOUNT_NUMBER` or `WIPAY_API_KEY` is unset, the app still starts. `POST /api/orders/:id/pay` returns
503 `payments-unavailable` and the checkout says card payment isn't available yet. Production refuses to start only
on a dangerous setting: `WIPAY_ENVIRONMENT` other than `live`, or the public sandbox key `123`. So catalog and sales
deploys are never blocked by a missing WiPay account, and test cards can never mark a live order paid.

### Owner reconciliation

The daily summary gets a second section: orders that reached WiPay (an attempt exists) but are still unpaid, with
contact details and attempt IDs, so the owner can match them against the WiPay dashboard. Marking such an order paid
by hand is out of scope until webhooks land; the owner contacts the customer directly.

### Checkout form and validation

Fields, all trimmed, control characters rejected (existing `field` helper in `server/lib/checkout.js`):

| Field | Rule |
| --- | --- |
| First name | required, max 30 (WiPay `fname` limit) |
| Last name | required, max 30 |
| Email | required, max 50 (WiPay limit), existing email regex, lowercased |
| Phone | optional, existing phone rule when present |
| Fulfillment | required, `pickup` or `shipping` (radio) |
| Pickup location | required for pickup, one of `PICKUP_LOCATIONS` (unchanged); ignored for shipping |
| Address line 1 | required for shipping, max 100 |
| Address line 2 | optional, max 100 |
| City / town | required for shipping, max 60 |
| State / province / parish | optional, max 60 |
| Postal code | optional, max 20 |
| Country | required for shipping, a code from `data/countries.js`, names shown via `Intl.DisplayNames` |
| Notes | optional, max 1000 (unchanged) |

Address fields show only when shipping is chosen; the server rejects address fields on a pickup order and a missing
pickup location on a pickup order. Shipping shows "We'll contact you about shipping cost and timing after you pay."
WiPay's `country` prefill uses the shipping country when there is one, else `JM`.

Mobile-first layout and existing form styles. No inline CSS or JS.

### Tax and processing fee

Rates live in a new `data/fees.js`, shared by the site and the API like `data/fulfillment.js`:
`TAX = { label: 'GCT', bps: 1500 }`, `PROCESSING_FEE = { label: 'Processing fee', bps: 483 }`. Changing a rate is a
commit, not an env var.

`quote()` in `server/lib/pricing.js` computes, with integer math and half-up rounding to the cent, once per order:

- `taxCents = round(subtotalCents * 1500 / 10000)`
- `feeCents = round((subtotalCents + taxCents) * 483 / 10000)` (the fee is on the amount charged, which includes GCT)
- `totalCents = subtotalCents + taxCents + feeCents`

The quote response adds `taxCents`, `feeCents`, and `tax`/`fee` objects `{ label, bps }` so the client renders lines
without hard-coding rates. `expectedTotalCents` at place-order is compared against this full total, so a rate change
between cart and checkout returns the existing `bag-changed` 409.

WiPay is sent `totalCents` with `fee_structure: merchant_absorb`, so WiPay adds nothing and its page shows exactly the
cart total. Our call: WiPay then deducts its 4.83% from the whole charge, including the fee line, so the store
absorbs about 0.23% of each order (fee on the fee). Exact totals for the customer beat grossing the fee up.

Cart breakdown (bag and checkout summary, same rows): Subtotal, `GCT (15%)`, `Processing fee (4.83%,
non-refundable)`, Total `USD`. Rates shown come from the quote. Receipt and daily summary show the same rows.

### Currency display

- New `GET /api/currencies`: `{ base: 'USD', updatedAt, rates: { JMD: 157.2, EUR: 0.92, ... } }`. Rates come from
  ExchangeRate-API's open endpoint (`https://open.er-api.com/v6/latest/USD`, no key, updates daily; its terms
  require an attribution link). The server caches the response in KV `fx:latest` and refetches at most every 12
  hours, on request or from the 15-minute cron, with a 10 s timeout. If the source fails it serves the last good
  rates; with none ever fetched it returns USD only and the site hides the picker. Concurrent refreshes are
  harmless: last write wins on an identical-shaped value. `Cache-Control: public, max-age=3600`. Rates are
  validated (positive finite numbers, 3-letter codes) before caching.
- New `data/countries.js`: ISO 3166-1 alpha-2 country code to ISO 4217 currency. Used both for the shipping country
  picker and for currency detection.
- Detection: first region subtag in `navigator.languages` (`en-JM` to `JM` to `JMD`); none, or a currency without a
  rate, falls back to USD. A currency picker (house `select` styles, names via `Intl.DisplayNames`) in the header
  or footer overrides it; the choice is kept in `localStorage` (wrapped in try/catch, works without it).
- Display: one client helper formats cents in the chosen currency with `Intl.NumberFormat`; every client price
  (product cards, product view, sale prices, bag lines, breakdown) goes through it and re-renders on change. Non-USD
  amounts show as estimates (`≈ JMD 7,860`). The checkout summary, Pay button, receipt and policies always state
  the USD amount actually charged: "You'll be charged $45.20 USD. Other currencies are estimates; your bank sets
  the final rate." Attribution link sits next to the picker.
- Server-side money (emails, summary, WiPay) stays USD only.

### Encryption

- AES-256-GCM with WebCrypto, key from new secret `CUSTOMER_DATA_KEY` (32 random bytes, base64). Envelope
  `{ v: 1, iv, ct }` (base64), fresh 12-byte IV per write.
- Encrypted: everything personal (customer, address, notes). Plain: IDs, lines, totals, statuses, payment
  transaction ID, timestamps, pickup location.
- Decrypt only where needed: receipt, daily summary, alerts that name a customer, the place-order response.
- Legacy plaintext records (no `pii`) still read. A one-off idempotent script (`npm run encrypt-orders`) encrypts
  existing `order:` and `submission:` records in place with an atomic check per key, so the privacy policy's
  "encrypted at rest" is true for old records too. Run once after the key is set.
- Saved daily-summary bodies (`digest-pending:`) contain customer details, so they are encrypted the same way.
- Production refuses to start without a valid `CUSTOMER_DATA_KEY`, same style as the existing secrets check in
  `main.js`.
- Losing the key loses every stored customer detail. The README must tell the owner to store it in a password
  manager, and never to rotate it by just replacing the value.

### Secrets and settings

New env vars, in `render.yaml` (`sync: false` for secrets), `.env.example` and the README checklist:

| Var | Prod | Dev service |
| --- | --- | --- |
| `WIPAY_ENVIRONMENT` | `live` | `sandbox` |
| `WIPAY_ACCOUNT_NUMBER` | owner's account | `1234567890` |
| `WIPAY_API_KEY` (secret) | owner's API key | `123` |
| `CUSTOMER_DATA_KEY` (secret) | new random key | different random key |

Base URL follows `WIPAY_ENVIRONMENT`. Startup rules are under "Payments switched off". `.env.example` uses the
public sandbox values; the CI secret scan must still pass.

### Emails, summary, policies

- Receipt (`server/emails/receipt.js`): sent only after paid. Shows paid time in Jamaica time, WiPay transaction
  ID, order total, the subtotal, GCT, processing fee (non-refundable) and USD total rows, pickup
  location or the shipping address with the "we'll contact you about shipping" line, and the 24-hour refund line
  linking the policy. Drops "No payment was collected".
- Daily summary (`server/lib/digest.js`, `recordRows`): lists paid orders by paid day, with name, email, phone,
  pickup location or full shipping address, transaction ID. "Order value, not collected revenue" changes to collected totals.
- Policies (`policies.html`): line 75 and line 61 rewritten. Payment is taken by WiPay on its hosted page, WiPay
  adds a processing fee, card details go to WiPay and never to Evincus. Privacy lists the postal address, WiPay as
  a service provider receiving name, email, phone and country, and that personal details are encrypted at rest.
  Refund policy: approved refunds cover the items and their GCT; the processing fee is non-refundable (keeping
  the existing mandatory-rights line). Terms: prices are listed and charged in USD, GCT is added at checkout,
  converted prices are estimates. Privacy: the currency choice is kept in browser storage. New shipping section: shipping is optional, arranged by hand after purchase,
  cost and timing confirmed with the customer and paid separately. Pickup section says pickup is one of two options.
  "Last updated" date bumped. README "no payment is collected" and "no delivery or shipping" text updated.
- Checkout copy: the "No payment is collected at checkout" line goes. The summary shows the full breakdown and the
  USD amount charged.

### Logging and alerts

Use the existing redacting logger. New events: `payment.started`, `payment.confirmed`, `payment.failed`,
`payment.hash_mismatch`, `payment.duplicate`. Fields: order ID, attempt ID, transaction ID, cents. Never the hash,
API key, or any personal detail. Add `wipayapikey` and `customerdatakey` to `PII_KEYS`. Alerts: hash mismatch through
the existing one-per-hour `alert`; duplicate payment once per order (keyed by order, not hourly), so a second
order's duplicate is never swallowed.

## Tests the builder must leave

Use the existing `node --test` setup with in-memory KV.

- Hash: a known transaction ID, total `"10.00"` and key `123` verify; a changed total, ID or hash fails.
- Total formatting: cents to 2-decimal string with integer math (`1005` to `"10.05"`, `5` to `"0.05"`).
- Return replayed twice: one `PAID`, one retry job, one `wipay-txn`.
- Two concurrent `confirmPayment` calls for the same transaction: one commit wins, same end state.
- Two different successful transactions for one order: order paid once, second recorded `duplicate`, one alert.
- `pay` called twice quickly: same `url`, one attempt saved.
- `pay` on a paid order: no WiPay call.
- `failed` return: order unpaid, attempt `failed`, a later `pay` makes a new attempt.
- Return and status routes work with `STATUS=maintenance`.
- Encryption round trip; legacy plaintext order still renders in receipt and summary; disk value contains no email.
- Tax and fee: rounding at half-cent edges, zero subtotal, totals equal the sum of rows, `expectedTotalCents`
  mismatch after a rate change returns `bag-changed`.
- Currencies: cache fresh, stale refetch, source down serves last good, never fetched returns USD only, bad rate
  values rejected; the source fetch is stubbed.
- Client: `en-JM` detects JMD, unknown region falls back to USD, formatting shows `≈` for non-USD.
- Validation: each new field's limits; phone optional; pickup needs a location and takes no address; shipping
  needs line 1, city and country.
- WiPay HTTP call is injected or stubbed; tests never reach WiPay.

## Left to the builder

- Module layout (e.g. `server/lib/wipay.js`, `server/lib/crypto.js`, `server/routes/payments.js`).
- MD5 via `node:crypto` (`createHash`, `timingSafeEqual`); `server/lib` already imports `node:` modules.
- Exact client UI states and copy, within the existing checkout look.
- Whether the submission record encrypts or drops its record copy once paid.
- Fixture and restore-check updates (`scripts/restore-check.mjs` writes a `NOT_COLLECTED` order fixture).
- Sandbox end-to-end run on `evincus-dev` before any live switch.

## Risks and follow-ups

- **Lost return.** If the customer pays and the browser never reaches `response_url`, the order stays unpaid while
  WiPay holds the money. The order still exists with encrypted contact details. Follow-up: WiPay `payment.success`
  webhook calling `confirmPayment` (HMAC-SHA256 over `timestamp.rawBody`, `X-WiPay-Webhook-Id` as dedupe key),
  once WiPay enables merchant webhooks and the payload is known.
- **USD on the Jamaica platform:** confirmed 2026-10-24,
  `GET https://jm.wipayfinancial.com/plugins/get/currencies?country_code=JM` returns `["JMD","USD"]`.
- **Email over 50 characters** cannot pay through WiPay; the form says so up front.
- **GCT on top assumes the business is GCT-registered.** Owner's decision; the rate is one line in `data/fees.js`.
- **Fee rate must match the WiPay plan.** Upgrading to a paid plan means changing `bps` to 437 (3.80% + GCT).
- **Exchange-rate source** is a free third-party service; if it disappears the site falls back to USD.
