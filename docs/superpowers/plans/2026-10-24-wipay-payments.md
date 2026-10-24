# WiPay Payments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Card payments through WiPay's hosted page, with GCT and processing-fee lines in the cart, encrypted
customer details, pickup-or-shipping checkout, and estimated prices in the visitor's currency.

**Architecture:** Orders are placed unpaid (existing idempotent `submitOrder`), then `POST /api/orders/:id/pay`
creates a WiPay session and the browser goes to WiPay. WiPay's redirect hits `GET /api/payments/wipay/return`,
which verifies the md5 hash and marks the order paid in one Deno KV atomic commit deduped on the WiPay transaction
ID. Customer details are sealed with AES-256-GCM before they reach KV. Exchange rates are cached in KV and only
change what the browser displays.

**Tech Stack:** Node 22, vanilla ES modules (no build), Deno KV via `@deno/kv` (`server/lib/kv-store.js`),
WebCrypto, `node:crypto` (md5 only), `node --test`.

**Spec:** `docs/superpowers/specs/2026-10-24-wipay-payments-design.md` (read it first; this plan does not repeat
its reasoning).

## Global Constraints

- No new npm dependencies.
- `server/` uses web-standard `Request`/`Response`; `node:` imports are allowed in `server/lib` (already used).
- No inline CSS or JS anywhere (no `style=`, no inline `<script>` blocks other than existing JSON-LD). CSS in
  `assets/css`, JS in `assets/js`.
- Mobile first: base CSS for ~375px, scale up with `min-width` queries.
- Money is integer cents; rounding is half-up: `Math.floor((n * bps + 5000) / 10000)`.
- `TAX = { label: 'GCT', bps: 1500 }`, `PROCESSING_FEE = { label: 'Processing fee', bps: 483 }`.
- WiPay: `country_code: 'JM'`, `currency: 'USD'`, `fee_structure: 'merchant_absorb'`, `method: 'credit_card_co'`,
  `origin: 'evincus'`. Live base `https://jm.wipayfinancial.com`, sandbox `https://jmsb.wipayfinancial.com`,
  path `/plugins/payments/request`, header `Accept: application/json`, timeout 10 s.
- Hash: `md5(transaction_id + formatTotal(totalCents) + WIPAY_API_KEY)`, lowercase hex, constant-time compare.
- Attempt ID: 16 chars `[A-Za-z0-9]`. Reuse an `open` attempt younger than 150 s.
- TTLs: unpaid order/submission 7 days (`UNPAID_TTL = 604800`); once an attempt exists or paid, `ORDER_TTL`.
- Field limits: first/last name 30, email 50, phone existing rule (optional), address line1/line2 100, city 60,
  region 60, postal 20, notes 1000.
- Every money path idempotent and race-free: decisions go through `env.ORDERS.commit({ checks })`; no
  read-then-write without a version check.
- Logs never carry personal details, the hash, `WIPAY_API_KEY` or `CUSTOMER_DATA_KEY`.
- FX source `https://open.er-api.com/v6/latest/USD`, refetch after 12 h, timeout 10 s, attribution link
  `https://www.exchangerate-api.com`.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Work on `dev`.

## Review Focus

- `order.html` reloaded, or opened again after a paid order: the cart must lose the ordered items once only. It
  consumes only when the session's pending checkout matches the order ID, then clears it (test in Task 9).
- Return URL with missing, duplicated or garbage params (truncated redirect, hand-typed URL): always a 303 to the
  failed page, never a 500, no state change (test in Task 5).
- A sale starting or ending between place-order and pay: WiPay gets the stored `order.totalCents`, never a fresh
  quote (test in Task 5).
- Browser region whose currency has no rate (or rates never loaded): USD, never `NaN` or an empty price (test in
  Task 11).
- Email of exactly 50 characters accepted, 51 rejected with a message naming the limit (test in Task 3).

---

### Task 1: GCT and processing fee in quotes and the cart

**Files:**
- Create: `data/fees.js`
- Modify: `server/lib/pricing.js` (`quote`), `assets/js/bag.js` (`footHtml`), `assets/css/index.css`
- Test: `tests/fees.test.mjs`, update `tests/quote.test.mjs`, `tests/checkout.test.mjs` (`expectedTotalCents`)

**Interfaces:**
- Produces: `TAX`, `PROCESSING_FEE`, `charges(subtotalCents: number) -> { taxCents, feeCents, totalCents }` in
  `data/fees.js`. `quote()` result gains `taxCents`, `feeCents`, `tax: { label, bps }`, `fee: { label, bps }`;
  `totalCents` is now the sum.

- [ ] **Step 1: Write failing tests** in `tests/fees.test.mjs`:

```js
test('charges rounds half-up per order', () => {
  assert.deepEqual(charges(10000), { taxCents: 1500, feeCents: 555, totalCents: 12055 });
  assert.deepEqual(charges(6998), { taxCents: 1050, feeCents: 389, totalCents: 8437 });
  assert.deepEqual(charges(33), { taxCents: 5, feeCents: 2, totalCents: 40 });
  assert.deepEqual(charges(0), { taxCents: 0, feeCents: 0, totalCents: 0 });
});
test('quote returns the breakdown and its sum', () => {
  const q = quote(FIXTURE, NOW, [{ id: 'alpha-tee', color: 'Black, white print', size: 'S', qty: 2 }]);
  assert.equal(q.subtotalCents, 6998); assert.equal(q.taxCents, 1050); assert.equal(q.feeCents, 389);
  assert.equal(q.totalCents, 8437);
  assert.deepEqual(q.tax, { label: 'GCT', bps: 1500 }); assert.deepEqual(q.fee, { label: 'Processing fee', bps: 483 });
});
```

  Plus in `tests/checkout.test.mjs`: placing with `expectedTotalCents: 6998` (subtotal only, the pre-fee total)
  returns 409 `bag-changed`.
- [ ] **Step 2: Run** `node --test tests/fees.test.mjs`. Expected: FAIL, `charges` not exported.
- [ ] **Step 3: Implement** `data/fees.js` and use `charges` in `quote()`. Update `expectedTotalCents` in existing
  tests to the new totals (6998 subtotal becomes 8437).
- [ ] **Step 4: Bag breakdown.** `footHtml` ready state renders rows: `Subtotal`, `GCT (15%)`,
  `Processing fee (4.83%, non-refundable)`, `Total … USD`. Percentages are formatted from `q.tax.bps` and
  `q.fee.bps` (`bps / 100` with trailing zeros dropped), not hard-coded.
- [ ] **Step 5: Run** `node --test`. Expected: all pass.
- [ ] **Step 6: Commit** `feat(pricing): add GCT and WiPay processing fee to quotes and cart`.

### Task 2: Customer-data encryption

**Files:**
- Create: `server/lib/crypto.js`
- Modify: `server/lib/log.js` (`PII_KEYS` add `wipayapikey`, `customerdatakey`, `pii`, `hash`),
  `tests/helpers/fake-env.mjs` (`makeEnv` sets `CUSTOMER_DATA_KEY: Buffer.alloc(32, 7).toString('base64')`)
- Test: `tests/crypto.test.mjs`

**Interfaces:**
- Produces: `dataKey(env) -> Promise<CryptoKey>` (imports `env.CUSTOMER_DATA_KEY` once per distinct value, throws
  `Error('CUSTOMER_DATA_KEY must be 32 bytes, base64')` otherwise), `seal(env, value) -> Promise<{ v: 1, iv, ct }>`,
  `unseal(env, envelope) -> Promise<any>`, `isSealed(x) -> boolean`, `validDataKey(base64) -> boolean`.

- [ ] **Step 1: Write failing tests:** round trip of `{ customer: { email: 'ann@example.com' } }`; two seals of the
  same value differ (`iv`); serialized envelope does not contain `ann@example.com`; `unseal` with a different key
  rejects; tampered `ct` rejects; `validDataKey` false for 31 bytes and for non-base64.
- [ ] **Step 2: Run** `node --test tests/crypto.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement** with `crypto.subtle` AES-GCM, 12-byte random IV, base64 fields.
- [ ] **Step 4: Run** `node --test`. Expected: all pass.
- [ ] **Step 5: Commit** `feat(security): AES-GCM sealing for customer details`.

### Task 3: Checkout fields, sealed unpaid orders

**Files:**
- Modify: `server/lib/checkout.js` (`parseCheckout`, replace `directRecord`), `server/lib/submissions.js`,
  `server/lib/orders.js`, `server/routes/checkout.js`, `server/lib/http.js` (`MESSAGES`), `data/countries.js`
  (create), `server/lib/delivery.js`
- Test: `tests/checkout.test.mjs`, `tests/submissions.test.mjs`

**Interfaces:**
- Consumes: Task 1 `quote`, Task 2 `seal`/`unseal`.
- Produces:
  - `COUNTRIES: Record<string, string>` (alpha-2 to ISO 4217) in `data/countries.js`, every ISO 3166-1 code.
  - `parseCheckout(body) -> { customer: { firstName, lastName, email, phone }, fulfillment: { type: 'pickup', location } | { type: 'shipping' }, address: { line1, line2, city, region, postalCode, country } | null, notes }`.
  - `buildOrder(env, id, q, details, now) -> Promise<record>`: `status: 'AWAITING_PAYMENT'`, `paymentStatus: 'UNPAID'`,
    `subtotalCents`, `taxCents`, `feeCents`, `taxBps`, `feeBps`, `totalCents`, `lines`, `fulfillment`, `placedAt`,
    `pii: seal({ customer, address, notes })`, `email: { customer: 'pending', owner: 'daily-summary', attempts: 0 }`.
    No plaintext `customer`, `payer` or `notes`.
  - `revealOrder(env, record) -> Promise<record & { customer: { firstName, lastName, name, email, phone }, address, notes }>`
    in `server/lib/orders.js`; legacy records (no `pii`) map `customer.name` to `name` and split on the last space.
  - `UNPAID_TTL = 604800` in `server/lib/orders.js`. `dayKey(record)` uses `record.payment?.paidAt ?? record.placedAt`.
  - Request body: `customer: { firstName, lastName, email, phone? }`,
    `fulfillment: { type: 'pickup', locationId } | { type: 'shipping', address: {...} }`, `notes?`, `items`,
    `checkoutToken`, `expectedTotalCents`.
  - `POST /api/orders` 201 response: `{ id, status, paymentStatus, fulfillment: { type }, totalCents }`, read from
    the current order (`findOrder`), not the submission copy.

- [ ] **Step 1: Update `body()` in `tests/checkout.test.mjs`** to the new shape and write failing tests:
  - placed order is `AWAITING_PAYMENT`/`UNPAID`, no email sent, no `email-retry:` and no `day:` key, order and
    submission `opts.expirationTtl === 604800`;
  - stored order JSON (`env.ORDERS.store.get('order:…').value`) contains no `ann@example.com`, no first name, no
    notes text; `revealOrder` returns them;
  - phone omitted is accepted; `phone: 'abc'` is `invalid-checkout`;
  - email of 50 chars accepted, 51 chars `invalid-checkout` (Review Focus);
  - first name of 31 chars rejected; control character in any field rejected;
  - pickup with an `address` rejected; pickup without `locationId` rejected; shipping without `line1`, `city` or
    with `country: 'XX'` rejected; shipping with only required fields accepted and its record has
    `fulfillment: { type: 'shipping' }`;
  - same token and payload twice returns the same order ID and one `order:` key (existing concurrency test kept).
- [ ] **Step 2: Run** `node --test tests/checkout.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement.** `submitOrder(env, id, fingerprint, record)` writes only the submission and the order,
  both with `UNPAID_TTL`; it no longer writes `day:` or `email-retry:`. Fingerprint is computed from the parsed
  plaintext details before sealing (as today). `placeOrderRoute` no longer calls `sendOrderEmails`.
  `MESSAGES['invalid-checkout']` becomes `'Check your name, email (50 characters max), phone, pickup or shipping details, then try again.'`.
  `deliverOrderEmails` reads the recipient from `revealOrder` instead of `record.payer.email`.
- [ ] **Step 4: Run** `node --test`. Expected: all pass (fix other tests that read `record.payer` or
  `NOT_COLLECTED` for new orders; legacy fixtures keep working through `revealOrder`).
- [ ] **Step 5: Commit** `feat(checkout): first/last name, optional phone, pickup or shipping address; orders placed unpaid and sealed`.

### Task 4: WiPay client library

**Files:**
- Create: `server/lib/wipay.js`
- Modify: `tests/helpers/fake-env.mjs` (`fakeUpstreams({ wipay })`: hosts `jm.wipayfinancial.com` and
  `jmsb.wipayfinancial.com`, `POST /plugins/payments/request` records the JSON body and replies
  `wipay.reply?.(body) ?? { url: 'https://jmsb.wipayfinancial.com/checkout/payment?x=1', message: 'OK', transaction_id: 'SB-12-1-' + body.order_id + '-20261024120000' }`)
- Test: `tests/wipay.test.mjs`

**Interfaces:**
- Produces:
  - `wipayConfig(env) -> null | { base, environment: 'live' | 'sandbox', accountNumber: number, apiKey }`; null when
    `WIPAY_ACCOUNT_NUMBER` or `WIPAY_API_KEY` is unset. `environment` from `WIPAY_ENVIRONMENT`, default `sandbox`.
  - `formatTotal(cents) -> string` (integer math).
  - `newAttemptId() -> string` (16 chars `[A-Za-z0-9]`, `crypto.getRandomValues`).
  - `validTransactionId(id, attemptId, environment) -> boolean`: `^SB-\d{1,2}-[^-]+-<attemptId>-\d{14}$` for sandbox,
    same without `SB-` for live.
  - `verifyHash({ transactionId, totalCents, apiKey, hash }) -> boolean`.
  - `requestPayment(config, { attemptId, totalCents, customer, address, responseUrl, version }) -> Promise<{ url, transactionId }>`;
    throws `HttpError('payment-unavailable', 502)` on network error, timeout, non-200, or missing `url`.

- [ ] **Step 1: Write failing tests:**

```js
assert.equal(formatTotal(1005), '10.05'); assert.equal(formatTotal(5), '0.05'); assert.equal(formatTotal(12055), '120.55');
assert.equal(verifyHash({ transactionId: 'SB-12-1-Ab3dE5gH7jK9mN1p-20261024120000', totalCents: 8037, apiKey: '123',
  hash: '5e1ca2042ff319ac51d62da59889d89e' }), true);
// false for: totalCents 8038, apiKey '124', hash uppercase-mangled to a different value, hash '' and hash of wrong length
assert.equal(validTransactionId('SB-12-1-Ab3dE5gH7jK9mN1p-20261024120000', 'Ab3dE5gH7jK9mN1p', 'sandbox'), true);
assert.equal(validTransactionId('SB-12-1-Ab3dE5gH7jK9mN1p-20261024120000', 'Ab3dE5gH7jK9mN1p', 'live'), false);
assert.equal(validTransactionId('SB-12-1-OTHERattempt00001-20261024120000', 'Ab3dE5gH7jK9mN1p', 'sandbox'), false);
assert.match(newAttemptId(), /^[A-Za-z0-9]{16}$/);
```

  Plus `requestPayment` against `fakeUpstreams`: body has `account_number` (number), `country_code: 'JM'`,
  `currency: 'USD'`, `environment`, `fee_structure: 'merchant_absorb'`, `method: 'credit_card_co'`,
  `order_id: attemptId`, `origin: 'evincus'`, `total: '84.37'` for 8437, `email`, `fname`, `lname`, `country`
  (shipping country or `'JM'`), `phone` only when `+` and 8 to 15 digits after stripping spaces, dashes, dots and
  parentheses, no address fields; `Accept: application/json` header. A 400 reply throws `payment-unavailable`.
- [ ] **Step 2: Run** `node --test tests/wipay.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement** `server/lib/wipay.js`; md5 and `timingSafeEqual` from `node:crypto` (compare lengths
  first). Add `MESSAGES['payment-unavailable'] = "Card payment couldn't start. Try again in a minute."` and
  `MESSAGES['payments-unavailable'] = "Card payment isn't available yet. Check back soon."`.
- [ ] **Step 4: Run** `node --test`. Expected: all pass.
- [ ] **Step 5: Commit** `feat(payments): WiPay request, hash verification and IDs`.

### Task 5: Payment start, return and confirmation

**Files:**
- Create: `server/lib/payments.js`, `server/routes/payments.js`
- Modify: `server/index.js` (routes, status-gate exemption, limits), `server/static.js` (gate exempts
  `/order.html`), `main.js` (`PAY_LIMIT: kvLimiter(kv, 'pay', { limit: 10, period: 60 })`)
- Test: `tests/payments.test.mjs`

**Interfaces:**
- Consumes: Tasks 2 to 4.
- Produces:
  - Keys: `attemptKey(id) = 'payment-attempt:' + id`, `txnKey(id) = 'wipay-txn:' + id`,
    `awaitingKey(day, orderId) = 'awaiting:' + day + ':' + orderId` (exported from `server/lib/payments.js`).
  - `startPayment(c, orderId) -> Promise<{ paid: true } | { url }>`.
  - `confirmPayment(c, { attempt, attemptId, transactionId, reportedTotal, currency }) -> Promise<{ orderId, outcome: 'paid' | 'already' | 'duplicate' }>`.
  - Routes: `POST /api/orders/(EV-<uuid>)/pay` (rate-limited by `PAY_LIMIT`), `GET /api/payments/wipay/return`,
    `GET /api/orders/(EV-<uuid>)/status` (rate-limited by `LINK_LIMIT`) returning
    `{ id, status, paymentStatus, totalCents, paidAt, transactionId, fulfillmentType }` and nothing personal.
  - Return redirects: `303 Location: /order.html?order=<id>&checkout=paid|failed`; unknown attempt
    `/order.html?checkout=failed`.

- [ ] **Step 1: Write failing tests** (WiPay via `fakeUpstreams({ wipay })`, env with
  `WIPAY_ACCOUNT_NUMBER: '1234567890'`, `WIPAY_API_KEY: '123'`, `WIPAY_ENVIRONMENT: 'sandbox'`; build return URLs
  with a real md5 from `node:crypto` over the attempt's `transaction_id` and `formatTotal(order.totalCents)`):
  - `pay` without WiPay config: 503 `payments-unavailable`, no WiPay call.
  - `pay` twice within 150 s: same `url`, one WiPay call, one `payment-attempt:` key; order now has `attemptId`,
    order and submission TTL `ORDER_TTL`, one `awaiting:` key.
  - `pay` after 151 s with the attempt still open: new attempt, new URL.
  - Two concurrent `pay` calls (`Promise.all`): both return the same `url`; one attempt referenced by the order.
  - `pay` with WiPay replying 400: 502 `payment-unavailable`, no attempt saved, order unchanged.
  - Sale between place and pay (Review Focus): place with `FIXTURE`, then `pay` with a `data` that has the product
    at a different price; WiPay `total` is still `formatTotal(order.totalCents)`.
  - Successful return: 303 to `paid`; order `PLACED`/`PAID`, `payment.transactionId`, `payment.paidAt === NOW iso`,
    `payment.chargedTotal`, one `wipay-txn:`, one `email-retry:`, one `day:` key on the paid day, attempt
    `state: 'paid'`, receipt email sent once.
  - Same return URL twice, and twice concurrently: identical end state, one `wipay-txn:`, one receipt email.
  - Two different successful transactions for one order (two attempts): order paid by the first; second gets
    `wipay-txn:` with `duplicate: true`; exactly one owner alert whose rows name both transaction IDs; second
    return redirects `paid`.
  - Bad hash, `SB-` ID in `live`, transaction ID for another attempt: 303 `failed`, order unpaid, hash-mismatch
    alert, log line has no `hash` value.
  - `status=failed`: 303 `failed`, attempt `failed`, order unpaid; a following `pay` creates a new attempt.
  - Garbage returns (Review Focus): no params; `order_id` unknown; `status=success` with no `hash`; repeated params
    (`?status=success&status=failed`); a 5 KB `transaction_id`. All 303 `failed`, no KV writes, never 500.
  - With `STATUS: 'maintenance'`: return and status routes still work; `pay` is 503.
  - `GET /api/orders/:id/status` JSON keys are exactly the seven listed; unknown ID 404.
- [ ] **Step 2: Run** `node --test tests/payments.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement `startPayment`.** Read order entry with version. Missing: 404 `not-found`. `PAID`:
  `{ paid: true }`. Order's `attemptId` attempt is `open` and `c.now - createdAt < 150000`: return its `url`.
  Otherwise `newAttemptId()`, `requestPayment` (reveal customer/address for the prefill;
  `responseUrl: c.env.API_URL + '/api/payments/wipay/return'`, `version: String(c.env.COMMIT_SHA).slice(0, 16)`),
  then one commit:
  checks `[order version]`, puts: attempt (`ORDER_TTL`), order with `attemptId` (`ORDER_TTL`), submission rewritten
  with `ORDER_TTL`, `awaitingKey(Jamaica day of now, orderId)` (`ORDER_TTL`). Lost commit: re-read and loop (max 3);
  if the order now has a fresh open attempt, return its `url`.
- [ ] **Step 4: Implement `confirmPayment`** exactly as spec section "Flow", step 5, max 3 rounds; the paid commit
  also rewrites the submission with `ORDER_TTL`. Log `payment.started` (Step 3), `payment.confirmed`,
  `payment.failed`, `payment.hash_mismatch`, `payment.duplicate` with order ID, attempt ID, transaction ID and
  cents only. The duplicate
  alert uses `alert(c, 'payment.duplicate', { subject, rows, dedupe: false })`; it only fires when the duplicate
  `wipay-txn:` commit wins, so it is once per transaction. After a `paid` outcome, `c.waitUntil(sendOrderEmails(c, latest))`.
  `reportedTotal` differing from `formatTotal(totalCents)` logs `payment.total_mismatch` (warn).
- [ ] **Step 5: Implement routes and gates.** Return route reads params with `URLSearchParams.get` (first value),
  caps each at 256 chars before use, and wraps everything in try/catch that logs and redirects `failed`.
  `server/index.js` status gate regex adds `payments/wipay/return` and `orders/[^/]+/status`. `server/static.js`
  gate adds `path !== '/order.html'`.
- [ ] **Step 6: Run** `node --test`. Expected: all pass.
- [ ] **Step 7: Commit** `feat(payments): start WiPay checkout and confirm payments idempotently`.

### Task 6: Receipt and daily summary

**Files:**
- Modify: `server/emails/receipt.js`, `server/lib/orders.js` (`recordRows`), `server/lib/digest.js`,
  `server/lib/delivery.js`
- Test: `tests/emails.test.mjs`, `tests/checkout.test.mjs` (summary tests)

**Interfaces:**
- Consumes: `revealOrder`, `awaitingKey`, `seal`/`unseal`.
- Produces: `receiptEmail(revealed)` and `recordRows(revealed)` take a revealed record.

- [ ] **Step 1: Write failing tests:**
  - receipt for a paid pickup order contains the paid time as `Oct 24, 2026, 7:00 AM` style Jamaica time
    (`Intl.DateTimeFormat('en-US', { timeZone: 'America/Jamaica', dateStyle: 'medium', timeStyle: 'short' })`),
    the transaction ID, rows `Subtotal`, `GCT (15%)`, `Processing fee (4.83%, non-refundable)`, `Total … USD`, the
    pickup location, a link to `/policies.html#refund` and "within 24 hours"; no "No payment was collected";
  - receipt for a shipping order shows the full address and "We'll contact you about shipping cost and timing";
  - daily summary lists only paid orders of that paid day, with name, email, phone, address or pickup, transaction
    ID and the four money rows; heading text says collected, not "order value";
  - summary has an "Reached WiPay, not paid" section listing unpaid orders from `awaiting:<day>:` with contact
    details and attempt ID; orders paid since are left out;
  - saved `digest-pending:` value contains no customer email (sealed), and the part still sends after a restart
    (cron run twice); a legacy plaintext `digest-pending:` part still sends;
  - legacy `NOT_COLLECTED` order with plaintext `customer`/`payer` still renders in receipt and summary.
- [ ] **Step 2: Run** `node --test tests/emails.test.mjs tests/checkout.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement.** Digest stores parts as `{ sent, subject, sealed }` where `sealed = seal(html)`; sending
  unseals (or uses legacy `html`). Delivery passes `revealOrder(env, record)` to `receiptEmail`.
- [ ] **Step 4: Run** `node --test`. Expected: all pass.
- [ ] **Step 5: Commit** `feat(email): paid receipts with transaction ID; summary of paid and unfinished orders`.

### Task 7: Startup checks and settings

**Files:**
- Modify: `main.js`, `render.yaml`, `.env.example`, `README.md` (deploy checklist, env table, "Orders and
  fulfillment" section)
- Test: `tests/runtime.test.mjs` (or a new `tests/startup.test.mjs`)

**Interfaces:**
- Produces: `productionConfigErrors(env) -> string[]` exported from a new `server/lib/startup.js`; `main.js`
  throws `new Error(errors.join('; '))` when non-empty and `ENVIRONMENT === 'production'`. The existing
  `ADMIN_TOKEN`/`NEWSLETTER_KEY` rule moves into it unchanged.

- [ ] **Step 1: Write failing tests** for `productionConfigErrors`: valid set returns `[]`; missing or invalid
  `CUSTOMER_DATA_KEY` errors; `CUSTOMER_DATA_KEY` equal to `ADMIN_TOKEN` errors; WiPay unset entirely returns `[]`
  (payments off); `WIPAY_API_KEY: '123'` errors; WiPay set with `WIPAY_ENVIRONMENT` unset or `sandbox` errors;
  `WIPAY_ENVIRONMENT: 'live'` with a real key returns `[]`.
- [ ] **Step 2: Run** the test. Expected: FAIL.
- [ ] **Step 3: Implement**, then settings: `render.yaml` prod `WIPAY_ENVIRONMENT: live`, `WIPAY_ACCOUNT_NUMBER`,
  `WIPAY_API_KEY`, `CUSTOMER_DATA_KEY` as `sync: false`; dev `WIPAY_ENVIRONMENT: sandbox`,
  `WIPAY_ACCOUNT_NUMBER: "1234567890"`, `WIPAY_API_KEY` and `CUSTOMER_DATA_KEY` `sync: false`. `.env.example`
  gets the sandbox values and `CUSTOMER_DATA_KEY=` with the generate command
  `node -e "console.log(crypto.randomBytes(32).toString('base64'))"`. README: replace "No payment service is used",
  add the four vars to the checklist, a key-backup warning ("store `CUSTOMER_DATA_KEY` in a password manager;
  losing it loses every stored customer detail; never rotate by replacing the value"), WiPay dashboard steps
  (API key from Developer page, Payment API tab).
- [ ] **Step 4: Run** `node --test` and `npm run check:security`. Expected: both pass.
- [ ] **Step 5: Commit** `feat(config): WiPay and data-key settings with production safety checks`.

### Task 8: Encrypt existing records

**Files:**
- Create: `scripts/encrypt-orders.mjs`; add `"encrypt-orders": "node --env-file-if-exists=.env scripts/encrypt-orders.mjs"` to `package.json`
- Modify: `scripts/restore-check.mjs` fixture (order fixture becomes a sealed `AWAITING_PAYMENT` record or stays
  legacy; it must still pass)
- Test: `tests/encrypt-orders.test.mjs`

**Interfaces:**
- Produces: `encryptOrders(env) -> Promise<{ scanned, sealed }>` exported from the script module (script runs it
  against `openKv(process.env.KV_PATH ?? '.kv.sqlite3')` wrapped in `kvStore`, only when run directly).

- [ ] **Step 1: Write failing tests** (fake KV): a legacy `order:` with plaintext `customer`, `payer`, `notes` and
  its `submission:` copy become sealed (`pii` present, plaintext fields gone, no email in stored JSON), TTLs kept;
  a second run seals nothing (`sealed: 0`); a record changed between read and write is retried, not overwritten
  (commit with version check).
- [ ] **Step 2: Run** the test. Expected: FAIL.
- [ ] **Step 3: Implement** with `list({ prefix })`, `getEntry`, and `commit({ checks: [{ key, version }], puts })`.
  Preserve each key's remaining TTL (`ORDER_TTL` is acceptable when the original is unknown).
- [ ] **Step 4: Run** `node --test` and `npm run check:restore`. Expected: pass.
- [ ] **Step 5: Commit** `feat(scripts): encrypt-orders seals existing customer details in place`.

### Task 9: Checkout UI and confirmation page

**Files:**
- Modify: `assets/js/checkout.js`, `assets/js/bag.js` (remove `renderPaid`/`onPaid` and the `paid` step; open on
  `#cart`), `assets/js/index.js` (open the bag when `location.hash === '#cart'`), `assets/css/index.css`
- Create: `order.html`, `assets/js/order-page.js`, styles in `assets/css/pages.css`
- Test: `tests/order-page.test.mjs`, `tests/static.test.mjs` (gate exemption)

**Interfaces:**
- Consumes: `POST /api/orders`, `POST /api/orders/:id/pay`, `GET /api/orders/:id/status`.
- Produces: `PENDING_KEY = 'evincus_pending_checkout'` session record now also holds `orderId` once placed.
  `settleReturn({ params, pending, cart, status }) -> { view: 'paid' | 'failed', consumed: boolean }` exported from
  `assets/js/order-page.js` (pure, testable), plus the page bootstrap.

- [ ] **Step 1: Write failing tests:**
  - `settleReturn` with paid status and `pending.orderId === order`: consumes `pending.items` once, clears pending,
    `consumed: true`;
  - called again (reload) with pending already cleared: `consumed: false`, cart unchanged (Review Focus);
  - paid status but pending for a different order: `view: 'paid'`, `consumed: false`;
  - status unpaid with `checkout=paid` in the URL: `view: 'failed'` (URL is never trusted);
  - static: `/order.html` served with `STATUS: 'stocking'`, `/index.html` is not.
- [ ] **Step 2: Run** `node --test tests/order-page.test.mjs tests/static.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Checkout form.** Fields per spec table, `autocomplete` values `given-name`, `family-name`, `email`,
  `tel`, `address-line1`, `address-line2`, `address-level2`, `address-level1`, `postal-code`, `country`. Pickup /
  shipping radio; address fieldset shown only for shipping (toggle the `hidden` attribute, no inline styles);
  country `select` from `COUNTRIES` with `Intl.DisplayNames(undefined, { type: 'region' })`, sorted by name.
  Summary repeats the four breakdown rows and the line
  `You'll be charged $X USD. Other currencies are estimates; your bank sets the final rate.` Remove
  "No payment is collected at checkout." Button label `Pay $X USD`.
- [ ] **Step 4: Submit flow.** Keep the existing pending/retry logic. After `POST /api/orders` succeeds, save
  `orderId` into pending, then `POST /api/orders/:id/pay`; `{ paid: true }` goes to `/order.html?order=<id>`;
  `{ url }` does `location.assign(url)`. `payments-unavailable` shows its message and keeps the form.
- [ ] **Step 5: `order.html`** follows `newsletter.html` (same head, tape, header, stylesheet links, no inline
  code). Paid view: "Payment received", order reference, transaction ID, paid time, "Your receipt is on its way to
  the email you entered.", refund-window line linking `/policies.html#refund`, "Keep shopping" link to `/`.
  Failed view: "Payment didn't go through", "Nothing was charged for this attempt.", link `Back to cart` to `/#cart`.
  `history.replaceState` drops the query string after reading it.
- [ ] **Step 6: Run** `node --test`. Expected: all pass. Then `npm run dev`, place a sandbox order end to end at
  375px width (card `4242424242424242`, any future expiry) and with `4000000000000002` (declined).
- [ ] **Step 7: Commit** `feat(checkout): pay through WiPay; confirmation page`.

### Task 10: Exchange rates API

**Files:**
- Create: `server/lib/fx.js`, `server/routes/currencies.js`
- Modify: `server/index.js` (route `GET /api/currencies`, cron calls `refreshRates`), `tests/helpers/fake-env.mjs`
  (`fakeUpstreams({ fx })` for host `open.er-api.com`)
- Test: `tests/fx.test.mjs`

**Interfaces:**
- Produces: `FX_KEY = 'fx:latest'`, `FX_MAX_AGE_MS = 43200000`,
  `getRates(c) -> Promise<{ base: 'USD', updatedAt: string | null, rates: Record<string, number> }>`,
  `refreshRates(c) -> Promise<boolean>`. Route responds with `getRates` JSON and `Cache-Control: public, max-age=3600`.

- [ ] **Step 1: Write failing tests:** empty cache fetches once and stores `{ fetchedAt, updatedAt, rates }`; fresh
  cache (< 12 h) does not fetch; stale cache returns the cached rates immediately and refreshes in `waitUntil`;
  source down or `result !== 'success'` keeps the last good value; never fetched and source down returns
  `{ base: 'USD', updatedAt: null, rates: { USD: 1 } }`; rates with `NaN`, `0`, negative, or a key like `usd` or
  `JMDX` are dropped; a body without `rates.USD === 1` is rejected whole; route sets the cache header.
- [ ] **Step 2: Run** `node --test tests/fx.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement.** `updatedAt` from `time_last_update_unix`. Plain `put` (last write wins).
- [ ] **Step 4: Run** `node --test`. Expected: all pass.
- [ ] **Step 5: Commit** `feat(currency): cached USD exchange rates API`.

### Task 11: Prices in the visitor's currency

**Files:**
- Create: `assets/js/currency.js`
- Modify: `assets/js/sale.js` (`priceHtml`), `assets/js/index.js`, `assets/js/product-view.js`,
  `assets/js/bag.js`, `assets/js/checkout.js` (estimate beside the USD summary only), `index.html` (footer `legal`
  row: `<label class="sr-only" for="currency">Currency</label><select id="currency" class="currency mono" hidden></select>`
  and `<a id="fxCredit" href="https://www.exchangerate-api.com" target="_blank" rel="noopener" hidden>Rates by Exchange Rate API</a>`),
  `assets/css/index.css`
- Test: `tests/currency.test.mjs`

**Interfaces:**
- Consumes: `GET /api/currencies`, `COUNTRIES`, `money`.
- Produces: `detectCurrency(languages: string[], rates) -> string`, `formatIn(cents, code, rates, locale = 'en') -> string`,
  `formatPrice(cents) -> string` (current choice), `initCurrency(select, credit) -> Promise<void>`,
  `onCurrencyChange(fn)`. Storage key `evincus_currency`.

- [ ] **Step 1: Write failing tests:**

```js
assert.equal(detectCurrency(['en-JM', 'en-US'], { USD: 1, JMD: 157.2 }), 'JMD');
assert.equal(detectCurrency(['en'], { USD: 1, JMD: 157.2 }), 'USD');
assert.equal(detectCurrency(['fr-ZZ'], { USD: 1 }), 'USD');
assert.equal(detectCurrency(['ja-JP'], { USD: 1, JMD: 157.2 }), 'USD'); // Review Focus: no JPY rate
assert.equal(formatIn(1000, 'USD', { USD: 1 }), '$10.00');
assert.equal(formatIn(5000, 'JMD', { USD: 1, JMD: 157.2 }), '≈ JMD 7,860.00');
assert.equal(formatIn(5000, 'JPY', { USD: 1 }), '$50.00'); // missing rate falls back, never NaN
```

  Plus: `initCurrency` with blocked `localStorage` (getter throws) still works; stored choice wins over detection;
  `/api/currencies` failing leaves the select hidden and prices in USD.
- [ ] **Step 2: Run** `node --test tests/currency.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement.** Every client price display goes through `formatPrice`. Grid, open product view and
  bag re-render on `onCurrencyChange`. Checkout summary keeps the USD amount as the main figure. Select options:
  codes with rates, labelled with `Intl.DisplayNames(undefined, { type: 'currency' })`.
- [ ] **Step 4: Run** `node --test`. Expected: all pass. Check at 375px with `en-JM` browser language that prices
  show `≈ JMD`, and the bag total still states USD.
- [ ] **Step 5: Commit** `feat(currency): show estimated prices in the visitor's currency`.

### Task 12: Policies and copy

**Files:**
- Modify: `policies.html`, `assets/js/bag.js` (`renderPay` copy links include shipping), `README.md`
- Test: `tests/static.test.mjs` (or a new `tests/policies.test.mjs`)

- [ ] **Step 1: Write failing test:** `policies.html` does not contain `No payment is collected` or
  `Checkout does not ask for card or bank details`; contains `WiPay`, `non-refundable`, `GCT`, `id="shipping"`,
  `estimates`; "Last updated" `datetime` equals the commit day.
- [ ] **Step 2: Run** it. Expected: FAIL.
- [ ] **Step 3: Write the copy** per spec "Emails, summary, policies": payment taken by WiPay on its hosted page,
  card details go to WiPay only; GCT 15% added at checkout; processing fee 4.83% shown in the cart, non-refundable;
  approved refunds cover items and their GCT; new `#shipping` section (optional, arranged by hand after purchase,
  cost and timing confirmed with the customer and paid separately); pickup is one of two options; prices listed
  and charged in USD, other currencies are estimates; privacy lists postal address, WiPay as a provider receiving
  name, email, phone and country, encryption at rest, currency choice in browser storage. Add `Shipping` to the
  policy nav and the footer Help links in `index.html`. README "no delivery or shipping" text updated.
- [ ] **Step 4: Run** `node --test`. Expected: all pass.
- [ ] **Step 5: Commit** `docs(policies): WiPay payments, GCT, fees, shipping and currency estimates`.

### Task 13: Sandbox run on evincus-dev

Needs the owner's go-ahead: pushing `dev` deploys the dev service.

- [ ] **Step 1:** Set `WIPAY_API_KEY=123` and a fresh `CUSTOMER_DATA_KEY` on `evincus-dev` in Render.
- [ ] **Step 2:** Push `dev`; wait for CI green and the dev deploy.
- [ ] **Step 3:** On the dev URL: pickup order paid with `4242424242424242`; shipping order paid; declined
  `4000000000000002` then Pay again succeeds; reload `order.html` after paying; press back from WiPay. Expected:
  each paid order shows on `order.html` as paid, `payment.transactionId` starts `SB-`, no duplicate, cart cleared
  once. Receipts go to the test inbox only if email is enabled on dev (it is disabled by default).
- [ ] **Step 4:** Record results in the PR description. No live switch until the owner has a WiPay BUSINESS
  account, API key, and has stored `CUSTOMER_DATA_KEY` safely.
