# Evincus Backend (Bag, Eras, Orders) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the static Evincus storefront a Cloudflare Worker API that owns the catalog and eras, quotes the bag, takes PayPal payments, logs orders, emails receipts, and reports problems, while the site stays on GitHub Pages.

**Architecture:** `data/*.json` is the single catalog source. `data/catalog.js` holds the pure catalog rules: era status, visibility, line status, image and money helpers. The browser, the Worker and the tests all use it. The Worker (`worker/src`) is a small router over focused route and lib modules, with KV for orders, Resend for email, and Workers Logs for observability. The site loads the catalog from the API at startup and falls back to static JSON for browsing only.

**Tech Stack:** Vanilla ES modules (browser and Worker), Cloudflare Workers + KV + Rate Limiting + Cron Triggers, `wrangler` 4, PayPal Orders v2 REST API, Resend REST API, `node --test` on Node 22, GitHub Actions + GitHub Pages.

**Spec:** `docs/superpowers/specs/2026-10-03-backend-bag-eras-design.md`

## Global Constraints

- Node 22 or newer for tests and tooling (import attributes `with { type: 'json' }`).
- No runtime dependencies. The only devDependency is `wrangler`. Tests use `node:test` and `node:assert/strict` only.
- Worker code uses only web platform APIs: `fetch`, `Request`, `Response`, `Headers`, `URL`, `crypto.subtle`, `crypto.getRandomValues`, `crypto.randomUUID`, `TextEncoder`, `btoa`. No `node:` imports and no `process.env` under `worker/`.
- All money is integer cents (`priceCents`, `unitCents`, `totalCents`). Format only for display (`money()`) and for PayPal (`fromCents()`).
- Bag line key and PayPal SKU format: `` `${id}|${color}|${size}` ``. Colour and size names may contain spaces and commas, never `|`.
- Max 10 per line (`MAX_QTY`), max 50 lines (`MAX_LINES`), request body max 16 KB (beacon 2 KB).
- The Worker's clock decides era status. Never trust the browser clock for buying.
- No PII in logs. `payer`, `shipTo`, `email`, `name`, `address`, `phone` keys are dropped at any depth.
- Every error body is `{ error: { code, message, requestId, ...extra } }`. `message` is shopper-readable, says what happened and what to do, and never apologises.
- **Site rule (user preference):** CSS lives only in `assets/css/*.css` and JS only in `assets/js/*.js` / `pages/*.js`. No new `style=` attributes, `<style>` blocks or inline `<script>`. Email HTML uses no styles at all, only plain tables.
- KV TTLs: order and day keys 63,072,000 s (2 years); alert dedup 3,600 s; PayPal error buckets 1,200 s.
- Alert dedup: one email per event type per hour, except `order.log_failed`, which is never deduped.
- Commit after every task. Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Values the human must supply (before Task 13)

- `OWNER_EMAIL`: where owner notifications and alerts go.
- The PayPal **client ID** and **secret** (sandbox first).
- A Cloudflare account, plus a `CLOUDFLARE_API_TOKEN` with "Edit Cloudflare Workers" permission.
- A Resend account with `evincus.shop` verified (SPF/DKIM DNS records).
- Whether `evincus.shop` DNS is on Cloudflare. If it isn't, the API stays on its `*.workers.dev` URL and the custom-domain route is left out.

## Review Focus

1. **Colour names with commas and spaces** (`"Black, white print"`) in bag keys, quotes, PayPal SKUs and capture re-pricing. Expected: they round-trip exactly, with no split on commas. Pinned in Task 4 (quote) and Task 7 (capture uses the fixture colour `Black, white print`).
2. **Absurd or wrongly typed quantities** (`1000000`, `"2"`, `1.5`). Expected: a huge integer is capped to 10 with status `qty-capped`, and non-integers give 400 `invalid-cart`. Pinned in Task 4.
3. **PayPal capture response without a payer email.** Expected: capture still succeeds, the customer receipt is marked `failed` and queued for retry, and the owner is still notified. Pinned in Task 8.
4. **HTML in product names reaching emails** (`Alpha <Tee>`). Expected: escaped in the receipt, owner and alert emails. Pinned in Task 5 (alert) and Task 8 (receipt).
5. **KV read failing during the capture idempotency check.** Expected: capture proceeds, and PayPal's `PayPal-Request-Id` stops a double charge. Pinned in Task 7.

---

## File structure

```
package.json                         Task 1   type: module, scripts, wrangler devDependency
data/eras.json                       Task 1   eras, newest first
data/products.json                   Task 1   products (cents, era slug, sold-out flags)
data/site.json                       Task 1   categories, lookbook, careNote
data/catalog.js                      Task 1   pure catalog rules shared by site, Worker, tests
tests/fixtures/images-snapshot.json  Task 1   imagesFor() output before migration
tests/helpers/fixture.mjs            Task 1   small fixed catalog + fixed clock for tests
tests/catalog.test.mjs               Task 1
tests/data.test.mjs                  Task 1
assets/js/store.js                   Task 2 (static) → Task 10 (API first)
assets/js/api.js                     Task 10  fetch wrapper, ApiError, beacon
assets/js/quote.js                   Task 11  bag quote state
pages/era.js                         Task 12  era page
worker/wrangler.toml                 Task 3 → Task 13
worker/src/index.js                  Task 3   router, CORS, request log, errors, cron (Task 8)
worker/src/lib/catalog.js            Task 3   bundles data/*.json for the Worker
worker/src/lib/http.js               Task 3   json, fail, HttpError, readJson, CORS, MESSAGES
worker/src/lib/log.js                Task 3   structured logger + redaction
worker/src/routes/health.js          Task 3
worker/src/routes/eras.js            Task 3
worker/src/routes/products.js        Task 3
worker/src/lib/pricing.js            Task 4   parseItems, quote, itemsFromUnit, unitMatchesQuote
worker/src/routes/quote.js           Task 4
worker/src/lib/email.js              Task 5   Resend client
worker/src/lib/alerts.js             Task 5   owner alerts, dedup, PayPal burst counter
worker/src/emails/html.js            Task 5   esc, money, layout
worker/src/emails/alert.js           Task 5
worker/src/lib/paypal.js             Task 6   PayPal REST + HMAC tag
worker/src/routes/orders.js          Task 6   create + paypalFailure
worker/src/lib/orders.js             Task 7   KV records
worker/src/routes/capture.js         Task 7
worker/src/emails/receipt.js         Task 8
worker/src/emails/owner.js           Task 8
worker/src/lib/delivery.js           Task 8   order email delivery + cron retry
worker/src/routes/beacon.js          Task 9
tests/helpers/fake-env.mjs           Task 3 (+ upstream fakes in Task 5)
tests/routes-catalog.test.mjs        Task 3
tests/quote.test.mjs                 Task 4
tests/alerts.test.mjs                Task 5
tests/orders-create.test.mjs         Task 6
tests/orders-capture.test.mjs        Task 7
tests/emails.test.mjs                Task 8
tests/beacon.test.mjs                Task 9
.github/workflows/deploy.yml         Task 13
```

Deviations from the spec's layout, chosen for focus: route tests are split across several files instead of one `routes.test.mjs`; order email delivery and the cron retry live in `lib/delivery.js` rather than in `lib/orders.js`, which stays KV-only; and `data/catalog.js` holds the pure rules, with `worker/src/lib/catalog.js` only bundling the JSON. Routes still never decide visibility or buyability themselves; they call `data/catalog.js`.

---

### Task 1: Catalog data as JSON + shared rules

**Files:**
- Create: `package.json`, `data/eras.json`, `data/products.json`, `data/site.json`, `data/catalog.js`, `tests/fixtures/images-snapshot.json`, `tests/helpers/fixture.mjs`, `tests/catalog.test.mjs`, `tests/data.test.mjs`
- Modify: `.gitignore`
- Keep (deleted in Task 14): `data/products.js` (Netlify functions still import it)

**Interfaces:**
- Produces (`data/catalog.js`):
  - `MAX_QTY = 10`
  - `lineKey(id, color, size) → string`
  - `eraStatus(era, now: Date) → 'upcoming'|'live'|'archived'`
  - `cacheSeconds(eras, now: Date, max = 60) → integer ≥ 0`
  - `lineStatus(data, now, { id, color, size }) → 'ok'|'sold-out'|'not-released'|'era-ended'|'unknown-item'`
  - `publicView(data, now) → { eras: Era&{status}[], products: Product&{buyable}[] }`
  - `eraSummary(era, products)`
  - `eraDetail(era)`
  - `imagesFor(product, colorName) → string[]|undefined`
  - `money(cents) → '$45.99'`
  - `findProduct(products, id)`
  - `data` is `{ eras, products, site? }`.
- Produces (`tests/helpers/fixture.mjs`): `NOW` (ms), `FIXTURE` (data).

- [ ] **Step 1: Add package.json and ignore local secrets**

`package.json`:
```json
{
  "name": "evincus",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22" },
  "scripts": {
    "test": "node --test",
    "dev:api": "wrangler dev --config worker/wrangler.toml",
    "deploy:api": "wrangler deploy --config worker/wrangler.toml"
  },
  "devDependencies": {
    "wrangler": "^4.40.0"
  }
}
```

Append to `.gitignore`:
```
.dev.vars
.wrangler/
_site/
```

Run: `npm install`
Expected: `node_modules/` created, `package-lock.json` written.

- [ ] **Step 2: Generate the JSON files from the current catalog**

Write this one-off script to the scratchpad (not the repo) as `convert.mjs`, then run it from the repo root with `node <scratchpad>/convert.mjs`:

```js
import { writeFileSync, mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const root = process.cwd();
const { PRODUCTS, CATEGORIES, LOOKBOOK, CARE_NOTE, imagesFor } =
  await import(pathToFileURL(resolve(root, 'data/products.js')).href);

const products = PRODUCTS.map(p => ({
  id: p.id,
  era: p.collection.toLowerCase(),
  name: p.name,
  category: p.category,
  priceCents: Math.round(p.price * 100),
  fabric: p.fabric,
  sizes: p.sizes,
  colors: p.colors,
  ...(p.images ? { images: p.images } : {}),
  soldOut: false,
  soldOutVariants: [],
}));

const firstImage = slug => {
  const p = PRODUCTS.find(x => x.collection.toLowerCase() === slug);
  return imagesFor(p, p.colors[0].name)[0];
};

const eras = [
  { slug: 'catastrophe', name: 'Catastrophe', tagline: 'Peace in chaos',
    story: 'Zip fleece, heavyweight cotton and distressed washes. In black, brown and bold prints.',
    hero: LOOKBOOK[0], dropsAt: null, endsAt: null },
  { slug: 'reflection', name: 'Reflection', tagline: 'Stripes on repeat',
    story: 'A striped track jacket and pants in a cotton-rich 365 g/m² knit.',
    hero: firstImage('reflection'), dropsAt: null, endsAt: null },
  { slug: 'core', name: 'Core', tagline: 'Always in the line-up',
    story: 'Heavyweight oversized tees that stay in the store between drops.',
    hero: firstImage('core'), dropsAt: null, endsAt: null },
];

const site = { categories: CATEGORIES, lookbook: LOOKBOOK, careNote: CARE_NOTE };

const snapshot = Object.fromEntries(PRODUCTS.map(p =>
  [p.id, Object.fromEntries(p.colors.map(c => [c.name, imagesFor(p, c.name)]))]));

const out = (f, v) => writeFileSync(resolve(root, f), JSON.stringify(v, null, 2) + '\n');
out('data/eras.json', eras);
out('data/products.json', products);
out('data/site.json', site);
mkdirSync(resolve(root, 'tests/fixtures'), { recursive: true });
out('tests/fixtures/images-snapshot.json', snapshot);
console.log(`${eras.length} eras, ${products.length} products`);
```

Expected output: `3 eras, 9 products` (the product count must equal `PRODUCTS.length`). Open `data/products.json` and confirm that `disaster-zone-tee` colours keep `ring` and `images`, and that every product has `era` set to `catastrophe`, `reflection` or `core`.

- [ ] **Step 3: Write the test fixture**

`tests/helpers/fixture.mjs`:
```js
// Small fixed catalog and clock for tests. Real data/*.json is only checked by data.test.mjs.
export const NOW = Date.parse('2026-10-03T12:00:00Z');

export const FIXTURE = {
  eras: [
    { slug: 'future', name: 'Future', tagline: 'Soon', story: 'Secret story', hero: 'https://img.test/future.jpg',
      dropsAt: '2026-10-10T17:00:00-05:00', endsAt: null },
    { slug: 'alpha', name: 'Alpha', tagline: 'Now', story: 'Alpha story', hero: 'https://img.test/alpha.jpg',
      dropsAt: '2026-01-01T00:00:00Z', endsAt: null },
    { slug: 'old', name: 'Old', tagline: 'Was', story: 'Old story', hero: 'https://img.test/old.jpg',
      dropsAt: null, endsAt: '2026-06-01T00:00:00Z' },
  ],
  products: [
    { id: 'alpha-tee', era: 'alpha', name: 'Alpha <Tee>', category: 'tees', priceCents: 3499, fabric: 'Cotton',
      sizes: ['S', 'M'],
      colors: [
        { name: 'Black, white print', hex: '#151515', images: ['https://img.test/a1.png', 'https://img.test/a2.png'] },
        { name: 'White', hex: '#F4F4F2' },
      ],
      images: ['https://img.test/a0.png'], soldOut: false, soldOutVariants: ['White|M'] },
    { id: 'alpha-hood', era: 'alpha', name: 'Alpha Hood', category: 'outerwear', priceCents: 4599, fabric: 'Fleece',
      sizes: ['M'], colors: [{ name: 'Black', hex: '#151515' }], images: ['https://img.test/h.png'],
      soldOut: true, soldOutVariants: [] },
    { id: 'future-tee', era: 'future', name: 'Future Tee', category: 'tees', priceCents: 9999, fabric: 'Cotton',
      sizes: ['M'], colors: [{ name: 'Black', hex: '#151515' }], images: ['https://img.test/f.png'],
      soldOut: false, soldOutVariants: [] },
    { id: 'old-tee', era: 'old', name: 'Old Tee', category: 'tees', priceCents: 2000, fabric: 'Cotton',
      sizes: ['M'], colors: [{ name: 'Black', hex: '#151515' }], images: ['https://img.test/o.png'],
      soldOut: false, soldOutVariants: [] },
  ],
  site: { categories: [{ id: 'all', name: 'Everything' }], lookbook: [], careNote: 'Wash cold.' },
};
```

- [ ] **Step 4: Write the failing catalog rule tests**

`tests/catalog.test.mjs`:
```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_QTY, lineKey, eraStatus, cacheSeconds, lineStatus, publicView, eraSummary, eraDetail, imagesFor, money, findProduct,
} from '../data/catalog.js';
import { FIXTURE, NOW } from './helpers/fixture.mjs';

const at = ms => new Date(ms);

test('era is upcoming until the exact drop instant, then live', () => {
  const era = { dropsAt: '2026-10-10T17:00:00-05:00', endsAt: null };
  const drop = Date.parse(era.dropsAt);
  assert.equal(eraStatus(era, at(drop - 1)), 'upcoming');
  assert.equal(eraStatus(era, at(drop)), 'live');
  assert.equal(eraStatus(era, at(drop + 1)), 'live');
});

test('era is archived from the exact end instant', () => {
  const era = { dropsAt: null, endsAt: '2026-06-01T00:00:00Z' };
  const end = Date.parse(era.endsAt);
  assert.equal(eraStatus(era, at(end - 1)), 'live');
  assert.equal(eraStatus(era, at(end)), 'archived');
  assert.equal(eraStatus(era, at(end + 1)), 'archived');
});

test('null dates mean always live', () => {
  assert.equal(eraStatus({ dropsAt: null, endsAt: null }, at(0)), 'live');
});

test('cacheSeconds caps at the max and never runs past the next boundary', () => {
  assert.equal(cacheSeconds([], at(NOW)), 60);
  assert.equal(cacheSeconds([{ dropsAt: new Date(NOW + 30_500).toISOString(), endsAt: null }], at(NOW)), 30);
  assert.equal(cacheSeconds([{ dropsAt: new Date(NOW + 400).toISOString(), endsAt: null }], at(NOW)), 0);
  assert.equal(cacheSeconds([{ dropsAt: new Date(NOW - 1).toISOString(), endsAt: null }], at(NOW)), 60);
  assert.equal(cacheSeconds([{ dropsAt: null, endsAt: new Date(NOW + 10_000).toISOString() }], at(NOW)), 10);
});

test('publicView hides products of upcoming eras and sets buyable', () => {
  const v = publicView(FIXTURE, at(NOW));
  assert.deepEqual(v.eras.map(e => [e.slug, e.status]), [['future', 'upcoming'], ['alpha', 'live'], ['old', 'archived']]);
  assert.deepEqual(v.products.map(p => [p.id, p.buyable]), [['alpha-tee', true], ['alpha-hood', false], ['old-tee', false]]);
});

test('lineStatus covers every status', () => {
  const s = item => lineStatus(FIXTURE, at(NOW), item);
  assert.equal(s({ id: 'alpha-tee', color: 'Black, white print', size: 'S' }), 'ok');
  assert.equal(s({ id: 'alpha-tee', color: 'White', size: 'M' }), 'sold-out');
  assert.equal(s({ id: 'alpha-hood', color: 'Black', size: 'M' }), 'sold-out');
  assert.equal(s({ id: 'future-tee', color: 'Black', size: 'M' }), 'not-released');
  assert.equal(s({ id: 'old-tee', color: 'Black', size: 'M' }), 'era-ended');
  assert.equal(s({ id: 'nope', color: 'Black', size: 'M' }), 'unknown-item');
  assert.equal(s({ id: 'alpha-tee', color: 'Neon', size: 'S' }), 'unknown-item');
  assert.equal(s({ id: 'alpha-tee', color: 'White', size: 'XXL' }), 'unknown-item');
});

test('a product whose era is missing counts as not released and is hidden', () => {
  const data = { eras: [], products: [FIXTURE.products[0]] };
  assert.equal(lineStatus(data, at(NOW), { id: 'alpha-tee', color: 'White', size: 'S' }), 'not-released');
  assert.equal(publicView(data, at(NOW)).products.length, 0);
});

test('eraSummary hides story; upcoming eras report zero products', () => {
  const v = publicView(FIXTURE, at(NOW));
  const [future, alpha] = v.eras;
  assert.deepEqual(eraSummary(future, v.products), {
    slug: 'future', name: 'Future', tagline: 'Soon', hero: 'https://img.test/future.jpg',
    status: 'upcoming', dropsAt: '2026-10-10T17:00:00-05:00', endsAt: null, productCount: 0,
  });
  assert.equal(eraSummary(alpha, v.products).productCount, 2);
  assert.ok(!('story' in eraSummary(alpha, v.products)));
});

test('eraDetail includes story except for upcoming eras', () => {
  const v = publicView(FIXTURE, at(NOW));
  assert.equal(eraDetail(v.eras[1]).story, 'Alpha story');
  assert.ok(!('story' in eraDetail(v.eras[0])));
});

test('imagesFor prefers colour images, then product images', () => {
  const tee = FIXTURE.products[0];
  assert.deepEqual(imagesFor(tee, 'Black, white print'), ['https://img.test/a1.png', 'https://img.test/a2.png']);
  assert.deepEqual(imagesFor(tee, 'White'), ['https://img.test/a0.png']);
  const noProductImages = { colors: [{ name: 'A', images: ['x'] }, { name: 'B' }] };
  assert.deepEqual(imagesFor(noProductImages, 'B'), ['x']);
});

test('money, lineKey, findProduct, MAX_QTY', () => {
  assert.equal(money(4599), '$45.99');
  assert.equal(money(0), '$0.00');
  assert.equal(lineKey('a', 'Black, white print', 'S'), 'a|Black, white print|S');
  assert.equal(findProduct(FIXTURE.products, 'old-tee').name, 'Old Tee');
  assert.equal(findProduct(FIXTURE.products, 'nope'), undefined);
  assert.equal(MAX_QTY, 10);
});
```

Run: `node --test tests/catalog.test.mjs`
Expected: FAIL with `Cannot find module` for `data/catalog.js`.

- [ ] **Step 5: Implement `data/catalog.js`**

```js
// Catalog rules shared by the site, the API and the tests. Pure: no I/O and no clock reads,
// so callers pass `now`. The API's clock is the one that decides what can be bought.

export const MAX_QTY = 10;

export const lineKey = (id, color, size) => `${id}|${color}|${size}`;

const time = iso => (iso ? Date.parse(iso) : null);

export function eraStatus(era, now) {
  const ms = +now;
  const drops = time(era.dropsAt);
  const ends = time(era.endsAt);
  if (drops !== null && ms < drops) return 'upcoming';
  if (ends !== null && ms >= ends) return 'archived';
  return 'live';
}

// How long a catalog response may be cached: never past the next drop or end.
export function cacheSeconds(eras, now, max = 60) {
  const ms = +now;
  const ahead = eras.flatMap(e => [time(e.dropsAt), time(e.endsAt)]).filter(t => t !== null && t > ms);
  if (!ahead.length) return max;
  return Math.max(0, Math.min(max, Math.floor((Math.min(...ahead) - ms) / 1000)));
}

const statusOf = (data, slug, now) => {
  const era = data.eras.find(e => e.slug === slug);
  return era ? eraStatus(era, now) : 'upcoming'; // a product pointing at a missing era is treated as unreleased
};

const isSoldOut = (p, color, size) =>
  p.soldOut === true || (p.soldOutVariants ?? []).includes(`${color}|${size}`);

// Status of one bag line. Checks run in this order so nothing leaks about unreleased products.
export function lineStatus(data, now, { id, color, size }) {
  const p = data.products.find(x => x.id === id);
  if (!p) return 'unknown-item';
  const era = statusOf(data, p.era, now);
  if (era === 'upcoming') return 'not-released';
  if (!p.sizes.includes(size) || !p.colors.some(c => c.name === color)) return 'unknown-item';
  if (era === 'archived') return 'era-ended';
  if (isSoldOut(p, color, size)) return 'sold-out';
  return 'ok';
}

// What a shopper may see at `now`: every era with its status, and products of released eras.
export function publicView(data, now) {
  const eras = data.eras.map(e => ({ ...e, status: eraStatus(e, now) }));
  const status = slug => eras.find(e => e.slug === slug)?.status ?? 'upcoming';
  const products = data.products
    .filter(p => status(p.era) !== 'upcoming')
    .map(p => ({
      ...p,
      soldOut: p.soldOut === true,
      soldOutVariants: p.soldOutVariants ?? [],
      buyable: status(p.era) === 'live' && p.soldOut !== true,
    }));
  return { eras, products };
}

export function eraSummary(era, products) {
  const { slug, name, tagline, hero, status, dropsAt, endsAt } = era;
  const productCount = status === 'upcoming' ? 0 : products.filter(p => p.era === slug).length;
  return { slug, name, tagline, hero, status, dropsAt, endsAt, productCount };
}

export function eraDetail(era) {
  const { slug, name, tagline, hero, status, dropsAt, endsAt, story } = era;
  const base = { slug, name, tagline, hero, status, dropsAt, endsAt };
  return status === 'upcoming' ? base : { ...base, story };
}

export function imagesFor(product, colorName) {
  const c = product.colors.find(x => x.name === colorName);
  return c?.images ?? product.images ?? product.colors[0]?.images;
}

export const money = cents => '$' + (cents / 100).toFixed(2);

export const findProduct = (products, id) => products.find(p => p.id === id);
```

Run: `node --test tests/catalog.test.mjs`
Expected: PASS, 11 tests.

- [ ] **Step 6: Write the data validation tests**

`tests/data.test.mjs`:
```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { imagesFor } from '../data/catalog.js';

const read = path => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const eras = read('../data/eras.json');
const products = read('../data/products.json');
const site = read('../data/site.json');
const snapshot = read('./fixtures/images-snapshot.json');

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

test('eras are well formed', () => {
  assert.ok(eras.length > 0);
  const slugs = new Set();
  for (const e of eras) {
    assert.match(e.slug, /^[a-z0-9-]+$/, `bad slug ${e.slug}`);
    assert.ok(!slugs.has(e.slug), `duplicate era ${e.slug}`);
    slugs.add(e.slug);
    assert.ok(typeof e.name === 'string' && e.name, `${e.slug}.name`);
    for (const k of ['tagline', 'story', 'hero']) assert.equal(typeof e[k], 'string', `${e.slug}.${k}`);
    for (const k of ['dropsAt', 'endsAt']) {
      assert.ok(e[k] === null || (ISO.test(e[k]) && !Number.isNaN(Date.parse(e[k]))), `${e.slug}.${k} must be null or ISO with offset`);
    }
    if (e.dropsAt && e.endsAt) assert.ok(Date.parse(e.endsAt) > Date.parse(e.dropsAt), `${e.slug} ends before it drops`);
  }
});

test('products are well formed and point at real eras', () => {
  const slugs = new Set(eras.map(e => e.slug));
  const categories = new Set(site.categories.map(c => c.id));
  const ids = new Set();
  for (const p of products) {
    assert.match(p.id, /^[a-z0-9-]+$/, `bad id ${p.id}`);
    assert.ok(!ids.has(p.id), `duplicate product ${p.id}`);
    ids.add(p.id);
    assert.ok(slugs.has(p.era), `${p.id} points at missing era ${p.era}`);
    assert.ok(categories.has(p.category), `${p.id} has unknown category ${p.category}`);
    assert.ok(Number.isInteger(p.priceCents) && p.priceCents > 0, `${p.id}.priceCents`);
    assert.ok(Array.isArray(p.sizes) && p.sizes.length, `${p.id}.sizes`);
    assert.ok(Array.isArray(p.colors) && p.colors.length, `${p.id}.colors`);
    for (const s of p.sizes) assert.ok(!s.includes('|'), `${p.id} size ${s} contains |`);
    for (const c of p.colors) {
      assert.ok(c.name && !c.name.includes('|'), `${p.id} colour ${c.name}`);
      assert.match(c.hex, /^#[0-9A-Fa-f]{6}$/, `${p.id} colour ${c.name} hex`);
    }
    assert.ok(imagesFor(p, p.colors[0].name)?.length, `${p.id} has no images`);
    assert.equal(typeof p.soldOut, 'boolean', `${p.id}.soldOut`);
    assert.ok(Array.isArray(p.soldOutVariants), `${p.id}.soldOutVariants`);
    for (const v of p.soldOutVariants) {
      const [color, size, ...rest] = v.split('|');
      assert.ok(!rest.length && p.colors.some(c => c.name === color) && p.sizes.includes(size), `${p.id} soldOutVariants "${v}"`);
    }
  }
});

test('images match the pre-migration snapshot', () => {
  assert.deepEqual(Object.keys(snapshot).sort(), products.map(p => p.id).sort());
  for (const p of products) {
    for (const c of p.colors) assert.deepEqual(imagesFor(p, c.name), snapshot[p.id][c.name], `${p.id} / ${c.name}`);
  }
});

test('site data is present', () => {
  assert.ok(site.categories.some(c => c.id === 'all'));
  assert.ok(site.lookbook.length > 0);
  assert.ok(typeof site.careNote === 'string' && site.careNote);
});
```

Run: `node --test`
Expected: PASS for all of `catalog`, `data` and the existing `orders.test.mjs`.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json .gitignore data/eras.json data/products.json data/site.json data/catalog.js tests/fixtures tests/helpers/fixture.mjs tests/catalog.test.mjs tests/data.test.mjs
git commit -m "Move catalog to JSON with eras and shared catalog rules"
```

---

### Task 2: Site reads the JSON catalog (no visible change)

**Files:**
- Create: `assets/js/store.js`
- Modify: `assets/js/app.js`, `assets/js/cart.js`, `assets/js/ui.js`, `assets/js/totals.js`, `assets/js/index.js`, `pages/home.js`, `pages/shop.js`, `pages/product.js`, `pages/about.js`, `pages/checkout.js`

**Interfaces:**
- Consumes: `data/catalog.js` (Task 1).
- Produces (`assets/js/store.js`):
  - `loadCatalog(): Promise<void>`
  - `eras()`, `products()`, `site()` → `{categories, lookbook, careNote}`
  - `isLive(): boolean`
  - `findProduct(id)`, `eraName(slug)`
- Produces (`assets/js/cart.js`): `lines()` returns `{ key, id, color, size, qty, name, priceCents, image, totalCents }[]`; `subtotal()` returns cents. The other exports are unchanged.

No automated tests: this is browser glue. Verification is manual in Step 9.

- [ ] **Step 1: Create `assets/js/store.js` (static source for now)**

```js
// The site's copy of the catalog. Loaded once at startup; pages read it synchronously after that.
import { publicView, findProduct as find } from '../../data/catalog.js';

let state = { eras: [], products: [], site: { categories: [], lookbook: [], careNote: '' }, live: false };

async function fetchJson(file) {
  const res = await fetch(new URL(`../../data/${file}`, import.meta.url));
  if (!res.ok) throw new Error(`${file} failed to load (${res.status})`);
  return res.json();
}

export async function loadCatalog() {
  const [eras, products, site] = await Promise.all(['eras.json', 'products.json', 'site.json'].map(fetchJson));
  const view = publicView({ eras, products }, new Date());
  state = { eras: view.eras, products: view.products, site, live: false };
}

export const eras = () => state.eras;
export const products = () => state.products;
export const site = () => state.site;
export const isLive = () => state.live;
export const findProduct = id => find(state.products, id);
export const eraName = slug => state.eras.find(e => e.slug === slug)?.name ?? '';
```

- [ ] **Step 2: Update `assets/js/cart.js` to cents and the store**

Replace the first line:
```js
import { findProduct, imagesFor } from '../../data/products.js';
```
with:
```js
import { imagesFor } from '../../data/catalog.js';
import { findProduct } from './store.js';
```

Replace the `return` inside `lines()`:
```js
      return { ...i, name: p.name, price: p.price, image: imagesFor(p, i.color)[0], total: p.price * i.qty };
```
with:
```js
      return { ...i, name: p.name, priceCents: p.priceCents, image: imagesFor(p, i.color)[0], totalCents: p.priceCents * i.qty };
```

Replace:
```js
export function subtotal() { return lines().reduce((n, l) => n + l.total, 0); }
```
with:
```js
export function subtotal() { return lines().reduce((n, l) => n + l.totalCents, 0); }
```

- [ ] **Step 3: Update `assets/js/ui.js` and `assets/js/totals.js`**

`ui.js` line 1 becomes:
```js
import { money, imagesFor } from '../../data/catalog.js';
```
and `${money(p.price)}` becomes `${money(p.priceCents)}`.

`totals.js` becomes:
```js
import { SHIPPING_USD } from './config.js';
import * as cart from './cart.js';

// Display-only totals in cents. Replaced by the server quote in Task 11.
export function orderTotals() {
  const lines = cart.lines();
  const subtotal = lines.reduce((n, l) => n + l.totalCents, 0);
  const shipping = lines.length ? Math.round(SHIPPING_USD * 100) : 0;
  return { lines, subtotal, shipping, total: subtotal + shipping };
}
```

- [ ] **Step 4: Update `assets/js/app.js`**

Replace line 8:
```js
import { money } from '../../data/products.js';
```
with:
```js
import { money } from '../../data/catalog.js';
import { loadCatalog } from './store.js';
```

In `renderBag()`, replace `${money(l.total)}` with `${money(l.totalCents)}`.

Replace the last three lines of the file:
```js
renderBag();
window.addEventListener('hashchange', navigate);
navigate();
```
with:
```js
await loadCatalog();
renderBag();
window.addEventListener('hashchange', navigate);
navigate();
```

- [ ] **Step 5: Update `pages/checkout.js`**

Line 1 becomes `import { money } from '../data/catalog.js';`, and in `summary()` replace `${money(l.total)}` with `${money(l.totalCents)}`. `subtotal`, `shipping` and `total` from `orderTotals()` are now cents, so the existing `money(subtotal)`, `money(shipping)` and `money(total)` calls stay as they are.

- [ ] **Step 6: Update `pages/shop.js` and `pages/about.js`**

`shop.js` line 1 becomes:
```js
import { products, site } from '../assets/js/store.js';
```
At the top of `render({ query })`, add:
```js
    const PRODUCTS = products();
    const CATEGORIES = site().categories;
```
The rest of `render` is unchanged.

`about.js` line 1 becomes `import { site } from '../assets/js/store.js';`. In `render()`, add `const LOOKBOOK = site().lookbook;` as the first line.

- [ ] **Step 7: Update `pages/home.js`**

Replace lines 1–5:
```js
import { PRODUCTS, LOOKBOOK } from '../data/products.js';
import { card } from '../assets/js/ui.js';

const drop = PRODUCTS.filter(p => p.collection === 'Catastrophe');
const more = PRODUCTS.filter(p => p.collection !== 'Catastrophe').slice(0, 4);
```
with:
```js
import { products, site } from '../assets/js/store.js';
import { card } from '../assets/js/ui.js';
```
Make these the first lines inside `render() {`:
```js
    const LOOKBOOK = site().lookbook;
    const drop = products().filter(p => p.era === 'catastrophe');
    const more = products().filter(p => p.era !== 'catastrophe').slice(0, 4);
```

- [ ] **Step 8: Update `pages/product.js` and `assets/js/index.js`**

`pages/product.js` line 1 becomes:
```js
import { imagesFor, money } from '../data/catalog.js';
import { findProduct, products, site, eraName } from '../assets/js/store.js';
```
Then make these replacements:
- `const related = PRODUCTS.filter(x => x.id !== p.id && (x.category === p.category || x.collection === p.collection)).slice(0, 4);` becomes `const related = products().filter(x => x.id !== p.id && (x.category === p.category || x.era === p.era)).slice(0, 4);`
- `<a href="#/shop" class="crumb">${esc(p.collection)} collection</a>` becomes `<a href="#/shop" class="crumb">${esc(eraName(p.era))} collection</a>`
- `${money(p.price)}` (both places) becomes `${money(p.priceCents)}`
- `${esc(CARE_NOTE)}` becomes `${esc(site().careNote)}`

`assets/js/index.js` (landing page) becomes:
```js
import { imagesFor, money } from '../../data/catalog.js';
import { loadCatalog, products, eraName } from './store.js';
const esc = t => String(t).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const TAGS = { 'disaster-zone-tee': ['New', true], 'made-for-chaos-tee': ['Distressed'], 'catastrophe-zip-hoodie': ['New', true], 'flaming-eye-tee': ['Core'] };
await loadCatalog();
const PRODUCTS = products();
const grid = document.getElementById('grid');
document.getElementById('total').textContent = PRODUCTS.length;
grid.innerHTML = PRODUCTS.map(p => {
  const imgs = imagesFor(p, p.colors[0].name) || [];
  const [front, back] = [imgs[0], imgs[1] || imgs[0]];
  const tag = TAGS[p.id];
  const colors = p.colors.length > 1 ? p.colors.length + ' colors' : p.colors[0].name;
  return `<a class="card" href="#shop" data-add>
    <div class="card__img">
      ${tag ? `<span class="tag ${tag[1] ? 'tag--hot ' : ''}mono">${tag[0]}</span>` : ''}
      <img src="${esc(front)}" alt="${esc(p.name)}" loading="lazy">
      <img class="alt" src="${esc(back)}" alt="" loading="lazy">
    </div>
    <div class="card__meta"><h3>${esc(p.name)}</h3><span class="price">${money(p.priceCents)}</span><span class="mono">${esc(eraName(p.era))} · ${esc(colors)} · USD</span></div>
  </a>`;
}).join('');
const count = document.getElementById('count');
grid.addEventListener('click', e => {
  const c = e.target.closest('[data-add]'); if (!c) return;
  e.preventDefault();
  count.value = (+count.value || 0) + 1;
  count.textContent = count.value;
});
document.getElementById('signup').addEventListener('submit', e => {
  e.preventDefault();
  const v = document.getElementById('email').value.trim();
  document.getElementById('note').textContent = /.+@.+\..+/.test(v) ? "You're on the list. Demo only, nothing was sent." : 'Enter a valid email address.';
});
```

- [ ] **Step 9: Verify nothing changed visually**

Run: `grep -rn "data/products.js" assets pages`
Expected: no output.

Run: `npx --yes http-server -p 5180 -c-1 .` in the background, then open `http://localhost:5180/index.store.html` and `http://localhost:5180/index.html` (Playwright or a browser). Check:
- The home page shows the Catastrophe grid with 4 products and the Staples grid.
- Shop shows the same counts per category as before, and prices match the old `$xx.xx` values.
- The product page shows "Catastrophe collection" in the crumb, the correct price, and care text.
- Adding to the bag shows the correct line price and subtotal.
- The landing page grid shows all products with era names.
- The console has no errors.

Run: `node --test`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add assets/js/store.js assets/js/app.js assets/js/cart.js assets/js/ui.js assets/js/totals.js assets/js/index.js pages/home.js pages/shop.js pages/product.js pages/about.js pages/checkout.js
git commit -m "Load site catalog from JSON through a shared store"
```

---

### Task 3: Worker skeleton, catalog routes, health, logging, CORS

**Files:**
- Create: `worker/wrangler.toml`, `worker/src/index.js`, `worker/src/lib/catalog.js`, `worker/src/lib/http.js`, `worker/src/lib/log.js`, `worker/src/routes/health.js`, `worker/src/routes/eras.js`, `worker/src/routes/products.js`, `tests/helpers/fake-env.mjs`, `tests/routes-catalog.test.mjs`

**Interfaces:**
- Consumes: `data/catalog.js` (Task 1), `tests/helpers/fixture.mjs` (Task 1).
- Produces:
  - `createApp({ data, clock }) → { fetch(req, env, ctx), scheduled(event, env, ctx) }`; the default export is `createApp()`.
  - Route handler signature: `(req: Request, c) → Response | Promise<Response>`, where `c = { env, data, now: Date, reqId: string, log, waitUntil(p), params: string[] }`.
  - `lib/http.js`: `HttpError(code, status)`, `MESSAGES`, `json(data, status?, headers?)`, `fail(c, code, status, extra?)`, `readJson(req, maxBytes = 16384)`, `corsHeaders(origin, env)`.
  - `lib/log.js`: `createLogger(base) → { info(event, fields?), warn, error, child(extra) }`, `redact(value)`, `PII_KEYS`.
  - `tests/helpers/fake-env.mjs`: `fakeKV()`, `fakeLimiter(limit)`, `makeEnv(over?)`, `makeCtx()`, `captureLogs()`, `call(method, path, opts?)`.

- [ ] **Step 1: Write the test helpers**

`tests/helpers/fake-env.mjs`:
```js
import { createApp } from '../../worker/src/index.js';
import { FIXTURE, NOW } from './fixture.mjs';

// In-memory stand-in for a KV namespace. Set `failPuts` / `failGets` to a predicate on the key to simulate outages.
export function fakeKV() {
  const store = new Map();
  return {
    store,
    failPuts: null,
    failGets: null,
    async get(key, type) {
      if (this.failGets?.(key)) throw new Error('KV get failed');
      if (!store.has(key)) return null;
      const { value } = store.get(key);
      return type === 'json' ? JSON.parse(value) : value;
    },
    async put(key, value, opts = {}) {
      if (this.failPuts?.(key)) throw new Error('KV put failed');
      store.set(key, { value: String(value), opts });
    },
    async delete(key) { store.delete(key); },
    async list({ prefix = '' } = {}) {
      const keys = [...store.keys()].filter(k => k.startsWith(prefix)).sort().map(name => ({ name }));
      return { keys, list_complete: true };
    },
  };
}

export function fakeLimiter(limit) {
  const hits = new Map();
  return {
    async limit({ key }) {
      const n = (hits.get(key) ?? 0) + 1;
      hits.set(key, n);
      return { success: n <= limit };
    },
  };
}

export function makeEnv(over = {}) {
  return {
    ENVIRONMENT: 'production',
    PAYPAL_ENV: 'sandbox',
    PAYPAL_CLIENT_ID: 'client-id',
    PAYPAL_CLIENT_SECRET: 'client-secret',
    ORDER_HMAC_KEY: 'hmac-test-key',
    RESEND_API_KEY: 're_test',
    EMAIL_FROM: 'Evincus <orders@evincus.shop>',
    OWNER_EMAIL: 'owner@evincus.shop',
    SHIPPING_USD: '5',
    ALLOWED_ORIGINS: 'https://evincus.shop,https://jojo6550.github.io',
    COMMIT_SHA: 'abc1234',
    ORDERS: fakeKV(),
    BEACON_LIMIT: fakeLimiter(10),
    ...over,
  };
}

// ctx.waitUntil collector; settle() also drains work queued by queued work.
export function makeCtx() {
  const pending = [];
  return {
    waitUntil: p => { pending.push(p); },
    async settle() { while (pending.length) await pending.shift(); },
  };
}

// Collects JSON log lines written with console.log until restore().
export function captureLogs() {
  const lines = [];
  const original = console.log;
  console.log = (...args) => {
    try { lines.push(JSON.parse(args[0])); } catch { original(...args); }
  };
  return { lines, restore() { console.log = original; } };
}

// One request through the Worker, with waitUntil work finished before returning.
export async function call(method, path, { body, raw, headers = {}, env = makeEnv(), clock = () => NOW, data = FIXTURE } = {}) {
  const app = createApp({ data, clock });
  const ctx = makeCtx();
  const init = { method, headers: { ...headers } };
  if (raw !== undefined) init.body = raw;
  else if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers['Content-Type'] = 'application/json';
  }
  const res = await app.fetch(new Request('https://api.test' + path, init), env, ctx);
  await ctx.settle();
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { res, status: res.status, json, text, env };
}
```

- [ ] **Step 2: Write the failing route tests**

`tests/routes-catalog.test.mjs`:
```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { call, makeEnv, captureLogs } from './helpers/fake-env.mjs';
import { FIXTURE, NOW } from './helpers/fixture.mjs';
import { redact } from '../worker/src/lib/log.js';

test('GET /api/eras lists eras with status; upcoming has no story and no products', async () => {
  const { status, json, res } = await call('GET', '/api/eras');
  assert.equal(status, 200);
  assert.equal(json.now, new Date(NOW).toISOString());
  assert.deepEqual(json.eras.map(e => [e.slug, e.status, e.productCount]), [['future', 'upcoming', 0], ['alpha', 'live', 2], ['old', 'archived', 1]]);
  assert.ok(json.eras.every(e => !('story' in e)));
  assert.equal(res.headers.get('cache-control'), 'public, max-age=60');
  assert.ok(res.headers.get('x-request-id'));
});

test('catalog cache never outlives the next drop', async () => {
  const drop = Date.parse(FIXTURE.eras[0].dropsAt);
  const { res } = await call('GET', '/api/eras', { clock: () => drop - 20_000 });
  assert.equal(res.headers.get('cache-control'), 'public, max-age=20');
});

test('upcoming era returns a teaser with no products or story', async () => {
  const { status, json } = await call('GET', '/api/eras/future');
  assert.equal(status, 200);
  assert.equal(json.name, 'Future');
  assert.equal(json.status, 'upcoming');
  assert.deepEqual(json.products, []);
  assert.ok(!('story' in json));
});

test('live era returns story and products with buyable flags', async () => {
  const { json } = await call('GET', '/api/eras/alpha');
  assert.equal(json.story, 'Alpha story');
  assert.deepEqual(json.products.map(p => [p.id, p.buyable, p.soldOutVariants]), [['alpha-tee', true, ['White|M']], ['alpha-hood', false, []]]);
});

test('unknown era is 404 with a shopper message and the request id', async () => {
  const { status, json, res } = await call('GET', '/api/eras/nope');
  assert.equal(status, 404);
  assert.equal(json.error.code, 'unknown-era');
  assert.equal(typeof json.error.message, 'string');
  assert.equal(json.error.requestId, res.headers.get('x-request-id'));
});

test('a product in an upcoming era is indistinguishable from an unknown one', async () => {
  const hidden = await call('GET', '/api/products/future-tee');
  const missing = await call('GET', '/api/products/nope');
  assert.equal(hidden.status, 404);
  assert.equal(missing.status, 404);
  assert.equal(hidden.json.error.code, missing.json.error.code);
  assert.equal(hidden.json.error.message, missing.json.error.message);
  assert.ok(!hidden.text.includes('Future Tee'));
});

test('product returns era summary and buyable', async () => {
  const { status, json } = await call('GET', '/api/products/old-tee');
  assert.equal(status, 200);
  assert.deepEqual(json.era, { slug: 'old', name: 'Old', status: 'archived' });
  assert.equal(json.buyable, false);
});

test('a drop goes live at dropsAt', async () => {
  const drop = Date.parse(FIXTURE.eras[0].dropsAt);
  assert.equal((await call('GET', '/api/products/future-tee', { clock: () => drop - 1 })).status, 404);
  assert.equal((await call('GET', '/api/products/future-tee', { clock: () => drop })).status, 200);
});

test('unknown path is 404, wrong method is 405', async () => {
  assert.equal((await call('GET', '/api/nope')).json.error.code, 'not-found');
  const r = await call('POST', '/api/eras', { body: {} });
  assert.equal(r.status, 405);
  assert.equal(r.json.error.code, 'method-not-allowed');
});

test('health reports catalog, KV and commit', async () => {
  const { status, json, res } = await call('GET', '/api/health');
  assert.equal(status, 200);
  assert.deepEqual(json, { ok: true, catalog: { eras: 3, products: 4 }, kv: 'ok', commit: 'abc1234' });
  assert.equal(res.headers.get('cache-control'), 'no-store');
});

test('health is 503 when KV fails', async () => {
  const env = makeEnv();
  env.ORDERS.failGets = () => true;
  const { status, json } = await call('GET', '/api/health', { env });
  assert.equal(status, 503);
  assert.equal(json.ok, false);
  assert.equal(json.kv, 'error');
});

test('CORS: allowed origin echoed, others get nothing, preflight is 204', async () => {
  const ok = await call('GET', '/api/eras', { headers: { Origin: 'https://evincus.shop' } });
  assert.equal(ok.res.headers.get('access-control-allow-origin'), 'https://evincus.shop');
  assert.equal(ok.res.headers.get('vary'), 'Origin');
  const bad = await call('GET', '/api/eras', { headers: { Origin: 'https://evil.test' } });
  assert.equal(bad.res.headers.get('access-control-allow-origin'), null);
  const pre = await call('OPTIONS', '/api/bag/quote', { headers: { Origin: 'https://evincus.shop' } });
  assert.equal(pre.status, 204);
  assert.match(pre.res.headers.get('access-control-allow-methods'), /POST/);
  assert.match(pre.res.headers.get('access-control-allow-headers'), /Content-Type/);
});

test('localhost is allowed only outside production', async () => {
  const headers = { Origin: 'http://localhost:5180' };
  const prod = await call('GET', '/api/eras', { headers });
  assert.equal(prod.res.headers.get('access-control-allow-origin'), null);
  const dev = await call('GET', '/api/eras', { headers, env: makeEnv({ ENVIRONMENT: 'development' }) });
  assert.equal(dev.res.headers.get('access-control-allow-origin'), 'http://localhost:5180');
});

test('unhandled errors return 500 and log "unhandled"', async () => {
  const logs = captureLogs();
  try {
    const { status, json } = await call('GET', '/api/eras', { data: null });
    assert.equal(status, 500);
    assert.equal(json.error.code, 'server-error');
  } finally { logs.restore(); }
  assert.ok(logs.lines.some(l => l.event === 'unhandled' && l.level === 'error'));
});

test('every request logs one request line with route, status and ms', async () => {
  const logs = captureLogs();
  try { await call('GET', '/api/eras/nope'); } finally { logs.restore(); }
  const req = logs.lines.filter(l => l.event === 'request');
  assert.equal(req.length, 1);
  assert.equal(req[0].route, 'GET /api/eras/nope');
  assert.equal(req[0].status, 404);
  assert.equal(req[0].level, 'warn');
  assert.equal(typeof req[0].ms, 'number');
  assert.ok(req[0].reqId);
});

test('redact drops PII keys at any depth', () => {
  const out = redact({ orderId: 'X', payer: { email: 'a@b.c' }, lines: [{ name: 'Tee', sku: 's' }], nested: { shipTo: {}, phone: '1', ok: 1 } });
  assert.deepEqual(out, { orderId: 'X', lines: [{ sku: 's' }], nested: { ok: 1 } });
});
```

Run: `node --test tests/routes-catalog.test.mjs`
Expected: FAIL with `Cannot find module` for `worker/src/index.js`.

- [ ] **Step 3: Implement the libs**

`worker/src/lib/catalog.js`:
```js
// The catalog bundled into the Worker at deploy. Rules live in data/catalog.js.
import eras from '../../../data/eras.json' with { type: 'json' };
import products from '../../../data/products.json' with { type: 'json' };
import site from '../../../data/site.json' with { type: 'json' };

export const CATALOG = { eras, products, site };
```

`worker/src/lib/log.js`:
```js
// One JSON object per line, readable by Workers Logs' query builder. PII never reaches a log.
export const PII_KEYS = new Set(['payer', 'shipTo', 'email', 'name', 'address', 'phone']);

export function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).filter(([k]) => !PII_KEYS.has(k)).map(([k, v]) => [k, redact(v)]));
  }
  return value;
}

export function createLogger(base = {}) {
  const write = (level, event, fields = {}) =>
    console.log(JSON.stringify(redact({ ts: new Date().toISOString(), level, event, ...base, ...fields })));
  return {
    info: (event, fields) => write('info', event, fields),
    warn: (event, fields) => write('warn', event, fields),
    error: (event, fields) => write('error', event, fields),
    child: extra => createLogger({ ...base, ...extra }),
  };
}
```

`worker/src/lib/http.js`:
```js
export class HttpError extends Error {
  constructor(code, status) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

// Shopper-facing messages. Say what happened and what to do next.
export const MESSAGES = {
  'not-found': "There's nothing at this address.",
  'method-not-allowed': "This address doesn't accept that kind of request.",
  'too-large': 'That request is too large to process.',
  'rate-limited': 'Too many requests. Wait a minute, then try again.',
  'server-error': 'Something went wrong on our side. Try again in a minute.',
  'unknown-era': "There's no collection at this address. It may have been renamed.",
  'unknown-product': "This piece isn't in the store. It may have sold out or been renamed.",
  'invalid-cart': "Your bag couldn't be read. Refresh the page and try again.",
  'invalid-order': "That order reference isn't valid. Start checkout again from your bag.",
  'invalid-beacon': 'That report was not in the expected format.',
  'bag-changed': 'Some items in your bag changed. Check your bag, then check out again.',
  'capture-refused': "This payment couldn't be verified, so you were not charged. Start checkout again from your bag.",
  'capture-mismatch': "Your payment needs a manual check. Don't pay again: we'll contact you by email within one business day.",
  'payment-declined': 'Your payment method was declined and you were not charged. Try another card or PayPal account.',
  'paypal-error': "PayPal didn't respond and you were not charged. Try again in a minute.",
};

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  });
}

export function fail(c, code, status, extra = {}) {
  const message = MESSAGES[code] ?? MESSAGES['server-error'];
  return json({ error: { code, message, requestId: c.reqId, ...extra } }, status, { 'Cache-Control': 'no-store' });
}

// Parses a JSON body. Returns undefined for unparseable bodies; throws 413 for oversized ones.
export async function readJson(req, maxBytes = 16384) {
  if (Number(req.headers.get('content-length') ?? 0) > maxBytes) throw new HttpError('too-large', 413);
  const text = await req.text();
  if (new TextEncoder().encode(text).length > maxBytes) throw new HttpError('too-large', 413);
  try { return JSON.parse(text); } catch { return undefined; }
}

const LOCAL = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

export function corsHeaders(origin, env) {
  if (!origin) return {};
  const allowed = String(env.ALLOWED_ORIGINS ?? '').split(',').map(s => s.trim()).filter(Boolean);
  const local = env.ENVIRONMENT !== 'production' && LOCAL.test(origin);
  if (!allowed.includes(origin) && !local) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Expose-Headers': 'x-request-id',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}
```

- [ ] **Step 4: Implement the routes**

`worker/src/routes/health.js`:
```js
import { json } from '../lib/http.js';

// Never calls PayPal, so uptime monitors can poll it freely.
export async function health(req, c) {
  const catalog = { eras: c.data.eras.length, products: c.data.products.length };
  let kv = 'ok';
  try { await c.env.ORDERS.get('health'); } catch { kv = 'error'; }
  const ok = catalog.eras > 0 && catalog.products > 0 && kv === 'ok';
  return json({ ok, catalog, kv, commit: c.env.COMMIT_SHA ?? 'dev' }, ok ? 200 : 503, { 'Cache-Control': 'no-store' });
}
```

`worker/src/routes/eras.js`:
```js
import { publicView, eraSummary, eraDetail, cacheSeconds } from '../../../data/catalog.js';
import { json, fail } from '../lib/http.js';

export const catalogCache = c => ({ 'Cache-Control': `public, max-age=${cacheSeconds(c.data.eras, c.now)}` });

export function listEras(req, c) {
  const v = publicView(c.data, c.now);
  c.log.info('era.list', { count: v.eras.length });
  return json({ now: c.now.toISOString(), eras: v.eras.map(e => eraSummary(e, v.products)) }, 200, catalogCache(c));
}

export function getEra(req, c) {
  const v = publicView(c.data, c.now);
  const era = v.eras.find(e => e.slug === c.params[0]);
  if (!era) return fail(c, 'unknown-era', 404);
  const products = era.status === 'upcoming' ? [] : v.products.filter(p => p.era === era.slug);
  return json({ ...eraDetail(era), products }, 200, catalogCache(c));
}
```

`worker/src/routes/products.js`:
```js
import { publicView } from '../../../data/catalog.js';
import { json, fail } from '../lib/http.js';
import { catalogCache } from './eras.js';

// Unreleased products answer exactly like missing ones.
export function getProduct(req, c) {
  const v = publicView(c.data, c.now);
  const p = v.products.find(x => x.id === c.params[0]);
  if (!p) return fail(c, 'unknown-product', 404);
  const era = v.eras.find(e => e.slug === p.era);
  return json({ ...p, era: { slug: era.slug, name: era.name, status: era.status } }, 200, catalogCache(c));
}
```

- [ ] **Step 5: Implement the router**

`worker/src/index.js`:
```js
import { CATALOG } from './lib/catalog.js';
import { createLogger } from './lib/log.js';
import { HttpError, corsHeaders, fail } from './lib/http.js';
import { health } from './routes/health.js';
import { listEras, getEra } from './routes/eras.js';
import { getProduct } from './routes/products.js';

const ROUTES = [
  ['GET', /^\/api\/health$/, health],
  ['GET', /^\/api\/eras$/, listEras],
  ['GET', /^\/api\/eras\/([a-z0-9-]+)$/, getEra],
  ['GET', /^\/api\/products\/([a-z0-9-]+)$/, getProduct],
];

export function createApp({ data = CATALOG, clock = () => Date.now() } = {}) {
  return {
    async fetch(req, env, ctx) {
      const started = Date.now();
      const url = new URL(req.url);
      const reqId = req.headers.get('cf-ray') ?? crypto.randomUUID();
      const log = createLogger({ reqId, route: `${req.method} ${url.pathname}` });
      const c = { env, data, now: new Date(clock()), reqId, log, waitUntil: p => ctx.waitUntil(p), params: [] };

      let res;
      try {
        if (req.method === 'OPTIONS') {
          res = new Response(null, { status: 204 });
        } else {
          const matches = ROUTES.filter(([, re]) => re.test(url.pathname));
          const hit = matches.find(([method]) => method === req.method);
          if (!matches.length) res = fail(c, 'not-found', 404);
          else if (!hit) res = fail(c, 'method-not-allowed', 405);
          else {
            c.params = url.pathname.match(hit[1]).slice(1);
            res = await hit[2](req, c);
          }
        }
      } catch (err) {
        if (err instanceof HttpError) res = fail(c, err.code, err.status);
        else {
          log.error('unhandled', { message: String(err?.message ?? err), stack: String(err?.stack ?? '') });
          res = fail(c, 'server-error', 500);
        }
      }

      res = new Response(res.body, res);
      for (const [k, v] of Object.entries(corsHeaders(req.headers.get('Origin'), env))) res.headers.set(k, v);
      res.headers.set('x-request-id', reqId);
      const level = res.status >= 500 ? 'error' : res.status >= 400 ? 'warn' : 'info';
      log[level]('request', { status: res.status, ms: Date.now() - started });
      return res;
    },
  };
}

export default createApp();
```

Run: `node --test tests/routes-catalog.test.mjs`
Expected: PASS, 16 tests.

- [ ] **Step 6: Add the wrangler config and check it bundles**

`worker/wrangler.toml` (KV ids are replaced with real ones in Task 13):
```toml
name = "evincus-api"
main = "src/index.js"
compatibility_date = "2026-09-01"
workers_dev = true

[vars]
ENVIRONMENT = "production"
PAYPAL_ENV = "sandbox"
PAYPAL_CLIENT_ID = "set-in-task-13"
SHIPPING_USD = "0"
OWNER_EMAIL = "set-in-task-13"
EMAIL_FROM = "Evincus <orders@evincus.shop>"
ALLOWED_ORIGINS = "https://evincus.shop,https://www.evincus.shop,https://jojo6550.github.io"
COMMIT_SHA = "dev"

[observability]
enabled = true

[[kv_namespaces]]
binding = "ORDERS"
id = "local-orders"
```

Create `.dev.vars` (gitignored) at the repo root, next to where `npm run dev:api` runs. If wrangler doesn't pick it up there, copy it to `worker/.dev.vars`:
```
ENVIRONMENT=development
```

Run: `npx wrangler deploy --config worker/wrangler.toml --dry-run --outdir .wrangler/dry`
Expected: "--dry-run: exiting now." with no bundling errors (this confirms the JSON imports bundle).

Run: `npm run dev:api` in the background, then `curl -s http://localhost:8787/api/eras` and `curl -s http://localhost:8787/api/health`.
Expected: eras JSON with `catastrophe`, `reflection` and `core` all `live`; health `ok: true`. Stop the dev server.

- [ ] **Step 7: Commit**

```bash
git add worker tests/helpers/fake-env.mjs tests/routes-catalog.test.mjs
git commit -m "Add Worker with catalog, era and health routes, logging and CORS"
```

---

### Task 4: Bag quote

**Files:**
- Create: `worker/src/lib/pricing.js`, `worker/src/routes/quote.js`, `tests/quote.test.mjs`
- Modify: `worker/src/index.js` (add the route)

**Interfaces:**
- Consumes: `lineStatus`, `lineKey`, `MAX_QTY`, `imagesFor` (Task 1); `json`, `fail`, `readJson` (Task 3).
- Produces (`lib/pricing.js`):
  - `MAX_LINES = 50`, `CartError`, `COUNTED: Set<'ok'|'qty-capped'>`
  - `fromCents(c) → '45.99'`, `shippingCents(env) → int`
  - `parseItems(items) → {id,color,size,qty,key}[]` (throws `CartError`)
  - `quote(data, now, items, shipping) → { lines, subtotalCents, shippingCents, totalCents, checkoutReady }`
  - `statusCounts(lines) → { [status]: n }`
  - `itemsFromUnit(unit) → items | null`
  - `unitMatchesQuote(unit, q) → boolean`
- A quote line is `{ key, id, color, size, qty, status }`. Lines other than `not-released` and `unknown-item` also carry `name, image, unitCents, totalCents`.

- [ ] **Step 1: Write the failing tests**

`tests/quote.test.mjs`:
```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { call, captureLogs } from './helpers/fake-env.mjs';

const item = (over = {}) => ({ id: 'alpha-tee', color: 'Black, white print', size: 'S', qty: 2, ...over });
const quote = items => call('POST', '/api/bag/quote', { body: { items } });

test('prices from the catalog, ignores client prices, keeps comma colour names intact', async () => {
  const { status, json } = await quote([{ ...item(), price: 0.01, priceCents: 1 }]);
  assert.equal(status, 200);
  assert.deepEqual(json.lines[0], {
    key: 'alpha-tee|Black, white print|S', id: 'alpha-tee', color: 'Black, white print', size: 'S', qty: 2,
    status: 'ok', name: 'Alpha <Tee>', image: 'https://img.test/a1.png', unitCents: 3499, totalCents: 6998,
  });
  assert.equal(json.subtotalCents, 6998);
  assert.equal(json.shippingCents, 500);
  assert.equal(json.totalCents, 7498);
  assert.equal(json.checkoutReady, true);
});

test('one bad line does not fail the bag; only countable lines are totalled', async () => {
  const { status, json } = await quote([
    item(),
    item({ color: 'White', size: 'M', qty: 1 }),
    { id: 'alpha-hood', color: 'Black', size: 'M', qty: 1 },
    { id: 'future-tee', color: 'Black', size: 'M', qty: 1 },
    { id: 'old-tee', color: 'Black', size: 'M', qty: 1 },
    { id: 'gone', color: 'Black', size: 'M', qty: 1 },
  ]);
  assert.equal(status, 200);
  assert.deepEqual(json.lines.map(l => l.status), ['ok', 'sold-out', 'sold-out', 'not-released', 'era-ended', 'unknown-item']);
  assert.equal(json.subtotalCents, 6998);
  assert.equal(json.totalCents, 7498);
  assert.equal(json.checkoutReady, false);
});

test('not-released and unknown lines leak no name, image or price', async () => {
  const { json, text } = await quote([{ id: 'future-tee', color: 'Black', size: 'M', qty: 1 }, { id: 'gone', color: 'X', size: 'Y', qty: 1 }]);
  for (const l of json.lines) for (const k of ['name', 'image', 'unitCents', 'totalCents']) assert.ok(!(k in l), `${l.status} has ${k}`);
  assert.ok(!text.includes('Future Tee'));
  assert.ok(!text.includes('9999'));
});

test('absurd quantities are capped at 10 and stay checkout-ready', async () => {
  const { json } = await quote([item({ qty: 1_000_000 })]);
  assert.equal(json.lines[0].status, 'qty-capped');
  assert.equal(json.lines[0].qty, 10);
  assert.equal(json.lines[0].totalCents, 34990);
  assert.equal(json.checkoutReady, true);
});

test('shipping is zero when nothing is countable', async () => {
  const { json } = await quote([{ id: 'old-tee', color: 'Black', size: 'M', qty: 1 }]);
  assert.equal(json.shippingCents, 0);
  assert.equal(json.totalCents, 0);
  assert.equal(json.checkoutReady, false);
});

test('malformed bags are 400 invalid-cart', async () => {
  const many = Array.from({ length: 51 }, (_, i) => item({ size: `S${i}` }));
  const bodies = [{}, { items: [] }, { items: 'x' }, { items: many }, { items: [item({ qty: '2' })] },
    { items: [item({ qty: 0 })] }, { items: [item({ qty: 1.5 })] }, { items: [item(), item()] },
    { items: [item({ color: 'a|b' })] }, { items: [null] }, { items: [item({ id: 7 })] }];
  for (const body of bodies) {
    const r = await call('POST', '/api/bag/quote', { body });
    assert.equal(r.status, 400, JSON.stringify(body).slice(0, 80));
    assert.equal(r.json.error.code, 'invalid-cart');
  }
  const raw = await call('POST', '/api/bag/quote', { raw: 'not json' });
  assert.equal(raw.status, 400);
});

test('bodies over 16 KB are 413', async () => {
  const r = await call('POST', '/api/bag/quote', { raw: JSON.stringify({ items: [item()], pad: 'x'.repeat(17000) }) });
  assert.equal(r.status, 413);
  assert.equal(r.json.error.code, 'too-large');
});

test('quote logs status counts and total', async () => {
  const logs = captureLogs();
  try { await quote([item(), { id: 'old-tee', color: 'Black', size: 'M', qty: 1 }]); } finally { logs.restore(); }
  const line = logs.lines.find(l => l.event === 'bag.quoted');
  assert.deepEqual(line.statuses, { ok: 1, 'era-ended': 1 });
  assert.equal(line.totalCents, 7498);
});
```

Run: `node --test tests/quote.test.mjs`
Expected: FAIL, with 404 `not-found` instead of 200.

- [ ] **Step 2: Implement `worker/src/lib/pricing.js`**

```js
import { MAX_QTY, lineKey, lineStatus, imagesFor } from '../../../data/catalog.js';

export const MAX_LINES = 50;
export const COUNTED = new Set(['ok', 'qty-capped']);

export class CartError extends Error {}

export const fromCents = c => (c / 100).toFixed(2);

export function shippingCents(env) {
  const n = Number(env.SHIPPING_USD ?? 0);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : 0;
}

const isName = s => typeof s === 'string' && s.length > 0 && s.length <= 100 && !s.includes('|');

// Shape checks only. Catalog problems become line statuses, not errors.
export function parseItems(items) {
  if (!Array.isArray(items) || !items.length || items.length > MAX_LINES) throw new CartError('invalid-cart');
  const seen = new Set();
  return items.map(i => {
    if (!i || typeof i !== 'object') throw new CartError('invalid-cart');
    const { id, color, size, qty } = i;
    if (![id, color, size].every(isName) || !Number.isInteger(qty) || qty < 1) throw new CartError('invalid-cart');
    const key = lineKey(id, color, size);
    if (seen.has(key)) throw new CartError('invalid-cart');
    seen.add(key);
    return { id, color, size, qty, key };
  });
}

// Prices a bag from the catalog. Client prices are never read.
export function quote(data, now, items, shipping) {
  const lines = parseItems(items).map(i => {
    let status = lineStatus(data, now, i);
    if (status === 'ok' && i.qty > MAX_QTY) status = 'qty-capped';
    const qty = Math.min(i.qty, MAX_QTY);
    const base = { key: i.key, id: i.id, color: i.color, size: i.size, qty, status };
    if (status === 'not-released' || status === 'unknown-item') return base;
    const p = data.products.find(x => x.id === i.id);
    return { ...base, name: p.name, image: imagesFor(p, i.color)?.[0] ?? null, unitCents: p.priceCents, totalCents: p.priceCents * qty };
  });
  const counted = lines.filter(l => COUNTED.has(l.status));
  const subtotalCents = counted.reduce((n, l) => n + l.totalCents, 0);
  const ship = counted.length ? shipping : 0;
  return {
    lines,
    subtotalCents,
    shippingCents: ship,
    totalCents: subtotalCents + ship,
    checkoutReady: lines.length > 0 && lines.every(l => COUNTED.has(l.status)),
  };
}

export const statusCounts = lines => lines.reduce((acc, l) => ({ ...acc, [l.status]: (acc[l.status] ?? 0) + 1 }), {});

// Rebuilds bag items from a PayPal purchase unit's SKUs. Null if any line is malformed.
export function itemsFromUnit(unit) {
  if (!Array.isArray(unit?.items) || !unit.items.length) return null;
  const items = [];
  for (const it of unit.items) {
    const parts = String(it?.sku ?? '').split('|');
    if (parts.length !== 3 || !/^[1-9]\d*$/.test(String(it.quantity))) return null;
    items.push({ id: parts[0], color: parts[1], size: parts[2], qty: Number(it.quantity) });
  }
  return items;
}

// True only if every line is plainly buyable and every amount PayPal holds equals the quote.
export function unitMatchesQuote(unit, q) {
  const money = c => ({ currency_code: 'USD', value: fromCents(c) });
  const same = (a, b) => a?.currency_code === b.currency_code && a?.value === b.value;
  return (
    q.lines.every(l => l.status === 'ok') &&
    unit.items.length === q.lines.length &&
    same(unit.amount, money(q.totalCents)) &&
    same(unit.amount?.breakdown?.item_total, money(q.subtotalCents)) &&
    same(unit.amount?.breakdown?.shipping, money(q.shippingCents)) &&
    q.lines.every((l, i) => unit.items[i].sku === l.key && same(unit.items[i].unit_amount, money(l.unitCents)))
  );
}
```

- [ ] **Step 3: Implement the route and register it**

`worker/src/routes/quote.js`:
```js
import { json, fail, readJson } from '../lib/http.js';
import { CartError, quote, shippingCents, statusCounts } from '../lib/pricing.js';

export async function quoteRoute(req, c) {
  const body = await readJson(req);
  try {
    const q = quote(c.data, c.now, body?.items, shippingCents(c.env));
    c.log.info('bag.quoted', { statuses: statusCounts(q.lines), totalCents: q.totalCents });
    return json(q, 200, { 'Cache-Control': 'no-store' });
  } catch (err) {
    if (err instanceof CartError) return fail(c, 'invalid-cart', 400);
    throw err;
  }
}
```

In `worker/src/index.js`, add the import `import { quoteRoute } from './routes/quote.js';` and append to `ROUTES`:
```js
  ['POST', /^\/api\/bag\/quote$/, quoteRoute],
```

Run: `node --test`
Expected: PASS (all files).

- [ ] **Step 4: Commit**

```bash
git add worker/src/lib/pricing.js worker/src/routes/quote.js worker/src/index.js tests/quote.test.mjs
git commit -m "Add bag quote endpoint with per-line availability"
```

---

### Task 5: Resend email client and owner alerts

**Files:**
- Create: `worker/src/lib/email.js`, `worker/src/lib/alerts.js`, `worker/src/emails/html.js`, `worker/src/emails/alert.js`, `tests/alerts.test.mjs`
- Modify: `tests/helpers/fake-env.mjs` (add `fakeUpstreams`), `worker/src/index.js` (alert on unhandled)

**Interfaces:**
- Consumes: `createLogger` (Task 3), `money` (Task 1).
- Produces:
  - `sendEmail(env, { to, subject, html, idempotencyKey }) → Promise<void>` (throws on failure)
  - `alert(c, event, { subject, rows = [], dedupe = true }) → Promise<void>` (never throws)
  - `countPaypalError(c) → Promise<void>` (never throws)
  - `emails/html.js`: `esc`, `money`, `layout(title, bodyHtml)`, `table(rows)`
  - `emails/alert.js`: `alertEmail({ event, subject, rows, reqId, at }) → string`
  - `fakeUpstreams({ paypal?, resend? }) → { orders, calls, emails, captures() }`

- [ ] **Step 1: Add the upstream fakes to `tests/helpers/fake-env.mjs`**

Append:
```js
// Fake PayPal + Resend on globalThis.fetch.
// paypal: { down, decline, paidValue, payer } ; resend: { fail(body) → boolean }
export function fakeUpstreams({ paypal = {}, resend = {} } = {}) {
  const orders = new Map();
  const calls = [];
  const emails = [];
  globalThis.fetch = async (input, init = {}) => {
    const u = new URL(typeof input === 'string' ? input : input.url);
    const method = init.method ?? 'GET';
    const headers = new Headers(init.headers);
    calls.push({ method, host: u.host, path: u.pathname, headers });
    const reply = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

    if (u.host === 'api.resend.com') {
      const body = JSON.parse(init.body);
      if (resend.fail?.(body)) return reply({ message: 'failed' }, 500);
      emails.push({ ...body, idempotencyKey: headers.get('Idempotency-Key') });
      return reply({ id: `em_${emails.length}` });
    }

    if (paypal.down) return reply({ name: 'INTERNAL_SERVER_ERROR' }, 500);
    if (u.pathname === '/v1/oauth2/token') return reply({ access_token: 'token' });
    if (u.pathname === '/v2/checkout/orders' && method === 'POST') {
      const id = `ORDER${orders.size + 1}ABCDEFG`;
      orders.set(id, { id, status: 'APPROVED', ...JSON.parse(init.body) });
      return reply({ id });
    }
    const m = u.pathname.match(/^\/v2\/checkout\/orders\/(\w+)(\/capture)?$/);
    const order = m && orders.get(m[1]);
    if (!order) return reply({ name: 'RESOURCE_NOT_FOUND' }, 404);
    if (!m[2]) return reply(order);
    if (paypal.decline) return reply({ name: 'UNPROCESSABLE_ENTITY' }, 422);
    const unit = order.purchase_units[0];
    const amount = paypal.paidValue ? { ...unit.amount, value: paypal.paidValue } : unit.amount;
    return reply({
      id: order.id,
      status: 'COMPLETED',
      payer: 'payer' in paypal ? paypal.payer : { name: { given_name: 'Ann', surname: 'Lee' }, email_address: 'ann@example.com' },
      purchase_units: [{
        shipping: { name: { full_name: 'Ann Lee' }, address: { address_line_1: '1 Main St', admin_area_2: 'Kingston', country_code: 'JM' } },
        payments: { captures: [{ id: 'CAPTURE1', amount }] },
      }],
    });
  };
  return { orders, calls, emails, captures: () => calls.filter(c => c.path.endsWith('/capture')) };
}
```

- [ ] **Step 2: Write the failing tests**

`tests/alerts.test.mjs`:
```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, fakeUpstreams, captureLogs, call } from './helpers/fake-env.mjs';
import { NOW } from './helpers/fixture.mjs';
import { createLogger } from '../worker/src/lib/log.js';
import { sendEmail } from '../worker/src/lib/email.js';
import { alert, countPaypalError } from '../worker/src/lib/alerts.js';

const ctxFor = (env, now = NOW) => ({ env, log: createLogger({}), now: new Date(now), reqId: 'req-1', waitUntil: () => {} });

test('sendEmail posts to Resend with the idempotency key', async () => {
  const up = fakeUpstreams();
  await sendEmail(makeEnv(), { to: 'a@b.c', subject: 'Hi', html: '<p>x</p>', idempotencyKey: 'k1' });
  assert.equal(up.emails.length, 1);
  assert.deepEqual(up.emails[0], { from: 'Evincus <orders@evincus.shop>', to: ['a@b.c'], subject: 'Hi', html: '<p>x</p>', idempotencyKey: 'k1' });
  assert.equal(up.calls[0].headers.get('Authorization'), 'Bearer re_test');
});

test('sendEmail throws when Resend fails or the address is missing', async () => {
  fakeUpstreams({ resend: { fail: () => true } });
  await assert.rejects(sendEmail(makeEnv(), { to: 'a@b.c', subject: 's', html: 'h', idempotencyKey: 'k' }));
  await assert.rejects(sendEmail(makeEnv(), { to: '', subject: 's', html: 'h', idempotencyKey: 'k' }));
});

test('alert emails the owner once per hour per event', async () => {
  const up = fakeUpstreams();
  const env = makeEnv();
  const logs = captureLogs();
  try {
    await alert(ctxFor(env), 'unhandled', { subject: 'Crash', rows: [['Message', 'boom']] });
    await alert(ctxFor(env), 'unhandled', { subject: 'Crash', rows: [['Message', 'boom']] });
  } finally { logs.restore(); }
  assert.equal(up.emails.length, 1);
  assert.deepEqual(up.emails[0].to, ['owner@evincus.shop']);
  assert.equal(up.emails[0].subject, '[Evincus alert] Crash');
  assert.equal(env.ORDERS.store.get('alert:unhandled').opts.expirationTtl, 3600);
  assert.ok(logs.lines.some(l => l.event === 'alert.sent'));
  assert.ok(logs.lines.some(l => l.event === 'alert.suppressed' && l.alertEvent === 'unhandled'));
});

test('alert with dedupe false always sends', async () => {
  const up = fakeUpstreams();
  const env = makeEnv();
  await alert(ctxFor(env), 'order.log_failed', { subject: 'A', dedupe: false });
  await alert(ctxFor(env), 'order.log_failed', { subject: 'B', dedupe: false });
  assert.equal(up.emails.length, 2);
});

test('alert never throws when Resend fails, and logs alert.failed', async () => {
  fakeUpstreams({ resend: { fail: () => true } });
  const logs = captureLogs();
  try { await alert(ctxFor(makeEnv()), 'unhandled', { subject: 'x' }); } finally { logs.restore(); }
  assert.ok(logs.lines.some(l => l.event === 'alert.failed'));
});

test('alert email escapes values', async () => {
  const up = fakeUpstreams();
  await alert(ctxFor(makeEnv()), 'unhandled', { subject: 'x', rows: [['Name', 'Alpha <Tee>']] });
  assert.ok(up.emails[0].html.includes('Alpha &lt;Tee&gt;'));
  assert.ok(!up.emails[0].html.includes('<Tee>'));
});

test('PayPal error burst alerts once at the 5th error in a 10-minute bucket', async () => {
  const up = fakeUpstreams();
  const env = makeEnv();
  for (let i = 0; i < 6; i++) await countPaypalError(ctxFor(env));
  assert.equal(up.emails.length, 1);
  assert.match(up.emails[0].subject, /PayPal/);
  const key = `paypal-errors:${Math.floor(NOW / 600000)}`;
  assert.equal(env.ORDERS.store.get(key).value, '6');
  assert.equal(env.ORDERS.store.get(key).opts.expirationTtl, 1200);
});

test('unhandled errors alert the owner', async () => {
  const up = fakeUpstreams();
  const logs = captureLogs();
  try { await call('GET', '/api/eras', { data: null }); } finally { logs.restore(); }
  assert.equal(up.emails.length, 1);
  assert.match(up.emails[0].subject, /Unhandled error/);
});
```

Run: `node --test tests/alerts.test.mjs`
Expected: FAIL with `Cannot find module` for `worker/src/lib/email.js`.

- [ ] **Step 3: Implement email, the HTML helpers, the alert template and alerts**

`worker/src/lib/email.js`:
```js
// Resend REST API. The idempotency key stops retries from sending twice.
export async function sendEmail(env, { to, subject, html, idempotencyKey }) {
  if (!env.RESEND_API_KEY) throw new Error('RESEND_API_KEY not set');
  if (!to) throw new Error('no recipient address');
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey,
    },
    body: JSON.stringify({ from: env.EMAIL_FROM, to: [to], subject, html }),
  });
  if (!res.ok) throw new Error(`Resend failed (${res.status})`);
}
```

`worker/src/emails/html.js`:
```js
// Plain HTML for email: no styles, so every client renders it the same way.
import { money } from '../../../data/catalog.js';

export { money };

export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const layout = (title, body) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title></head><body><h1>${esc(title)}</h1>${body}</body></html>`;

export const table = rows =>
  `<table>${rows.map(([k, v]) => `<tr><th align="left">${esc(k)}</th><td>${esc(v)}</td></tr>`).join('')}</table>`;
```

`worker/src/emails/alert.js`:
```js
import { layout, table } from './html.js';

export function alertEmail({ event, subject, rows, reqId, at }) {
  return layout(subject, table([['Event', event], ['When', at.toISOString()], ['Request id', reqId], ...rows]) +
    '<p>Search Workers Logs for the request id to see what happened.</p>');
}
```

`worker/src/lib/alerts.js`:
```js
import { sendEmail } from './email.js';
import { alertEmail } from '../emails/alert.js';

// Emails the owner. One alert per event per hour unless dedupe is false. Never throws.
export async function alert(c, event, { subject, rows = [], dedupe = true }) {
  try {
    const key = `alert:${event}`;
    if (dedupe && await c.env.ORDERS.get(key)) {
      c.log.info('alert.suppressed', { alertEvent: event });
      return;
    }
    await sendEmail(c.env, {
      to: c.env.OWNER_EMAIL,
      subject: `[Evincus alert] ${subject}`,
      html: alertEmail({ event, subject, rows, reqId: c.reqId, at: c.now }),
      idempotencyKey: `alert-${event}-${c.reqId}`,
    });
    if (dedupe) await c.env.ORDERS.put(key, '1', { expirationTtl: 3600 });
    c.log.info('alert.sent', { alertEvent: event });
  } catch (err) {
    c.log.error('alert.failed', { alertEvent: event, message: String(err?.message ?? err) });
  }
}

// Counts PayPal failures per 10-minute bucket; the 5th in a bucket alerts. Never throws.
export async function countPaypalError(c) {
  try {
    const key = `paypal-errors:${Math.floor(+c.now / 600000)}`;
    const n = Number((await c.env.ORDERS.get(key)) ?? 0) + 1;
    await c.env.ORDERS.put(key, String(n), { expirationTtl: 1200 });
    if (n === 5) await alert(c, 'paypal.burst', { subject: 'PayPal errors: checkout may be down', rows: [['Errors in this 10-minute window', '5 or more']] });
  } catch (err) {
    c.log.error('alert.failed', { alertEvent: 'paypal.burst', message: String(err?.message ?? err) });
  }
}
```

- [ ] **Step 4: Alert on unhandled errors in the router**

In `worker/src/index.js`, add `import { alert } from './lib/alerts.js';` and, in the `catch` branch right after `log.error('unhandled', …)`, add:
```js
          c.waitUntil(alert(c, 'unhandled', { subject: 'Unhandled error', rows: [['Route', `${req.method} ${url.pathname}`], ['Message', String(err?.message ?? err)]] }));
```

That alert now calls `fetch`, so the Task 3 test must not reach the real Resend API. In `tests/routes-catalog.test.mjs`, change the import to `import { call, makeEnv, captureLogs, fakeUpstreams } from './helpers/fake-env.mjs';` and make `fakeUpstreams();` the first line of the `'unhandled errors return 500 and log "unhandled"'` test.

Run: `node --test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/src/lib/email.js worker/src/lib/alerts.js worker/src/emails worker/src/index.js tests/helpers/fake-env.mjs tests/alerts.test.mjs
git commit -m "Add Resend email client and deduplicated owner alerts"
```

---

### Task 6: PayPal client and order creation

**Files:**
- Create: `worker/src/lib/paypal.js`, `worker/src/routes/orders.js`, `tests/orders-create.test.mjs`
- Modify: `worker/src/index.js`

**Interfaces:**
- Consumes: `quote`, `shippingCents`, `fromCents`, `CartError` (Task 4); `countPaypalError` (Task 5); `json`, `fail`, `readJson` (Task 3).
- Produces (`lib/paypal.js`):
  - `CURRENCY = 'USD'`, `PaypalError` (`.op`, `.status`, `.upstream`)
  - `newNonce() → hex string`
  - `signTag(env, nonce, value) → Promise<string>` (`nonce.hexsig`), `verifyTag(env, customId, value) → Promise<boolean>`
  - `createOrder(env, q, nonce)`, `getOrder(env, id)`, `captureOrder(env, id)` (sends `PayPal-Request-Id: id`)
- Produces (`routes/orders.js`): `createOrderRoute(req, c)`, `paypalFailure(c, err) → Response` (rethrows anything that isn't a `PaypalError`).

- [ ] **Step 1: Write the failing tests**

`tests/orders-create.test.mjs`:
```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { call, makeEnv, fakeUpstreams, captureLogs } from './helpers/fake-env.mjs';
import { verifyTag } from '../worker/src/lib/paypal.js';

const item = (over = {}) => ({ id: 'alpha-tee', color: 'Black, white print', size: 'S', qty: 2, ...over });
const create = (items, env = makeEnv()) => call('POST', '/api/orders', { body: { items }, env });

test('creates a PayPal order priced from the catalog with a server-signed tag', async () => {
  const up = fakeUpstreams();
  const env = makeEnv();
  const { status, json } = await create([item()], env);
  assert.equal(status, 200);
  const unit = up.orders.get(json.id).purchase_units[0];
  assert.deepEqual(unit.amount, {
    currency_code: 'USD', value: '74.98',
    breakdown: { item_total: { currency_code: 'USD', value: '69.98' }, shipping: { currency_code: 'USD', value: '5.00' } },
  });
  assert.deepEqual(unit.items, [{
    name: 'Alpha <Tee>', description: 'Black, white print / S', sku: 'alpha-tee|Black, white print|S', quantity: '2',
    unit_amount: { currency_code: 'USD', value: '34.99' }, category: 'PHYSICAL_GOODS',
  }]);
  assert.match(unit.custom_id, /^[0-9a-f]{24}\.[0-9a-f]{64}$/);
  assert.equal(await verifyTag(env, unit.custom_id, '74.98'), true);
  assert.equal(await verifyTag(env, unit.custom_id, '0.01'), false);
  assert.equal(await verifyTag(makeEnv({ ORDER_HMAC_KEY: 'other' }), unit.custom_id, '74.98'), false);
});

test('a bag that is not checkout-ready is 409 bag-changed with lines, and PayPal is not called', async () => {
  const up = fakeUpstreams();
  for (const items of [[item(), { id: 'old-tee', color: 'Black', size: 'M', qty: 1 }], [item({ qty: 11 })]]) {
    const { status, json } = await create(items);
    assert.equal(status, 409);
    assert.equal(json.error.code, 'bag-changed');
    assert.ok(Array.isArray(json.error.lines));
  }
  assert.equal(up.calls.length, 0);
});

test('malformed bags are 400 without calling PayPal', async () => {
  const up = fakeUpstreams();
  const { status } = await create([item({ qty: 'x' })]);
  assert.equal(status, 400);
  assert.equal(up.calls.length, 0);
});

test('PayPal outage is 502 paypal-error and is logged without PII', async () => {
  fakeUpstreams({ paypal: { down: true } });
  const logs = captureLogs();
  let r;
  try { r = await create([item()]); } finally { logs.restore(); }
  assert.equal(r.status, 502);
  assert.equal(r.json.error.code, 'paypal-error');
  const e = logs.lines.find(l => l.event === 'paypal.error');
  assert.equal(e.op, 'auth');
  assert.equal(e.upstreamStatus, 500);
});

test('five PayPal failures in ten minutes alert the owner once', async () => {
  const up = fakeUpstreams({ paypal: { down: true } });
  const env = makeEnv();
  const logs = captureLogs();
  try { for (let i = 0; i < 6; i++) await create([item()], env); } finally { logs.restore(); }
  assert.equal(up.emails.length, 1);
  assert.match(up.emails[0].subject, /PayPal errors/);
});
```

Run: `node --test tests/orders-create.test.mjs`
Expected: FAIL with `Cannot find module` for `worker/src/lib/paypal.js`.

- [ ] **Step 2: Implement `worker/src/lib/paypal.js`**

```js
import { fromCents } from './pricing.js';

export const CURRENCY = 'USD';

export class PaypalError extends Error {
  constructor(op, status, upstream) {
    super(`PayPal ${op} failed (${status})${upstream ? ` ${upstream}` : ''}`);
    this.op = op;
    this.status = status;
    this.upstream = upstream ?? null;
  }
}

const apiBase = env => (env.PAYPAL_ENV === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com');

async function accessToken(env) {
  if (!env.PAYPAL_CLIENT_ID || !env.PAYPAL_CLIENT_SECRET) throw new Error('PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET not set');
  const res = await fetch(`${apiBase(env)}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + btoa(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new PaypalError('auth', res.status);
  return (await res.json()).access_token;
}

async function api(env, op, path, { method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(apiBase(env) + path, {
    method,
    headers: { Authorization: `Bearer ${await accessToken(env)}`, 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new PaypalError(op, res.status, data.name);
  return data;
}

// Orders carry a tag only this server can produce, so orders made elsewhere with the public client ID can't be captured here.
const enc = new TextEncoder();
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const unhex = s => (/^[0-9a-f]{64}$/.test(s) ? Uint8Array.from(s.match(/../g), h => parseInt(h, 16)) : null);

async function hmacKey(env) {
  if (!env.ORDER_HMAC_KEY) throw new Error('ORDER_HMAC_KEY not set');
  return crypto.subtle.importKey('raw', enc.encode(env.ORDER_HMAC_KEY), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export function newNonce() {
  return hex(crypto.getRandomValues(new Uint8Array(12)));
}

export async function signTag(env, nonce, value) {
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(env), enc.encode(`${nonce}|${CURRENCY}|${value}`));
  return `${nonce}.${hex(sig)}`;
}

export async function verifyTag(env, customId, value) {
  const [nonce, sig, ...rest] = String(customId ?? '').split('.');
  const bytes = unhex(sig ?? '');
  if (!nonce || !bytes || rest.length) return false;
  return crypto.subtle.verify('HMAC', await hmacKey(env), bytes, enc.encode(`${nonce}|${CURRENCY}|${value}`));
}

export async function createOrder(env, q, nonce) {
  const value = fromCents(q.totalCents);
  const money = c => ({ currency_code: CURRENCY, value: fromCents(c) });
  return api(env, 'create', '/v2/checkout/orders', {
    method: 'POST',
    body: {
      intent: 'CAPTURE',
      purchase_units: [{
        description: 'Evincus order',
        custom_id: await signTag(env, nonce, value),
        amount: {
          currency_code: CURRENCY,
          value,
          breakdown: { item_total: money(q.subtotalCents), shipping: money(q.shippingCents) },
        },
        items: q.lines.map(l => ({
          name: l.name.slice(0, 127),
          description: `${l.color} / ${l.size}`.slice(0, 127),
          sku: l.key.slice(0, 127),
          quantity: String(l.qty),
          unit_amount: money(l.unitCents),
          category: 'PHYSICAL_GOODS',
        })),
      }],
    },
  });
}

export const getOrder = (env, id) => api(env, 'get', `/v2/checkout/orders/${encodeURIComponent(id)}`);

// PayPal-Request-Id makes a repeated capture of the same order return the first result instead of charging twice.
export const captureOrder = (env, id) =>
  api(env, 'capture', `/v2/checkout/orders/${encodeURIComponent(id)}/capture`, {
    method: 'POST',
    body: {},
    headers: { 'PayPal-Request-Id': id },
  });
```

- [ ] **Step 3: Implement the create route and register it**

`worker/src/routes/orders.js`:
```js
import { json, fail, readJson } from '../lib/http.js';
import { CartError, quote, shippingCents } from '../lib/pricing.js';
import { PaypalError, createOrder, newNonce } from '../lib/paypal.js';
import { countPaypalError } from '../lib/alerts.js';

// Maps PayPal failures to responses. Declines are the shopper's card, not an outage, so they don't count toward alerts.
export function paypalFailure(c, err) {
  if (!(err instanceof PaypalError)) throw err;
  c.log.error('paypal.error', { op: err.op, upstreamStatus: err.status, upstream: err.upstream });
  if (err.status === 422) return fail(c, 'payment-declined', 422);
  c.waitUntil(countPaypalError(c));
  return fail(c, 'paypal-error', 502);
}

export async function createOrderRoute(req, c) {
  const body = await readJson(req);
  let q;
  try {
    q = quote(c.data, c.now, body?.items, shippingCents(c.env));
  } catch (err) {
    if (err instanceof CartError) return fail(c, 'invalid-cart', 400);
    throw err;
  }
  if (!q.checkoutReady || q.lines.some(l => l.status !== 'ok')) {
    c.log.warn('order.refused', { code: 'bag-changed' });
    return fail(c, 'bag-changed', 409, { lines: q.lines });
  }
  try {
    const order = await createOrder(c.env, q, newNonce());
    c.log.info('order.created', { orderId: order.id, totalCents: q.totalCents });
    return json({ id: order.id }, 200, { 'Cache-Control': 'no-store' });
  } catch (err) {
    return paypalFailure(c, err);
  }
}
```

In `worker/src/index.js`, add `import { createOrderRoute } from './routes/orders.js';` and append to `ROUTES`:
```js
  ['POST', /^\/api\/orders$/, createOrderRoute],
```

Run: `node --test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add worker/src/lib/paypal.js worker/src/routes/orders.js worker/src/index.js tests/orders-create.test.mjs
git commit -m "Create PayPal orders from the Worker with HMAC-tagged amounts"
```

---

### Task 7: Capture with re-pricing, buyable check, KV order log and idempotency

**Files:**
- Create: `worker/src/lib/orders.js`, `worker/src/routes/capture.js`, `tests/orders-capture.test.mjs`
- Modify: `worker/src/index.js`

**Interfaces:**
- Consumes: `getOrder`, `captureOrder`, `verifyTag`, `CURRENCY` (Task 6); `paypalFailure` (Task 6); `quote`, `itemsFromUnit`, `unitMatchesQuote`, `COUNTED`, `CartError`, `shippingCents` (Task 4); `alert` (Task 5).
- Produces (`lib/orders.js`):
  - `ORDER_TTL = 63072000`, `orderKey(id)`
  - `findOrder(env, id)`, `saveOrder(env, record)` (order + day key), `updateOrder(env, record)` (order key only)
  - `buildRecord(captured, q, now) → record`, `recordRows(record) → [label, value][]`
- Record: `{ id, captureId, capturedAt, status, lines: [{key,name,color,size,qty,unitCents}], subtotalCents, shippingCents, totalCents, payer: {name, firstName, email}, shipTo: {name, address}, email: {customer, owner, attempts} }`.
- Capture response: `{ id, status: 'COMPLETED', totalCents, name, email }`. `name` is the payer's first name and `email` their address, kept so the thank-you page can greet the shopper (an addition to the spec's shape).
- Produces (`routes/capture.js`): `captureRoute(req, c)` and `afterCapture(c, record, persisted)`. Task 7 implements `afterCapture` as a no-op; Task 8 replaces its body with email delivery.

- [ ] **Step 1: Write the failing tests**

`tests/orders-capture.test.mjs`:
```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { call, makeEnv, fakeUpstreams, captureLogs } from './helpers/fake-env.mjs';
import { FIXTURE, NOW } from './helpers/fixture.mjs';

const item = (over = {}) => ({ id: 'alpha-tee', color: 'Black, white print', size: 'S', qty: 2, ...over });
const create = async (env, items = [item()]) => (await call('POST', '/api/orders', { body: { items }, env })).json.id;
const capture = (env, orderID, opts = {}) => call('POST', '/api/orders/capture', { body: { orderID }, env, ...opts });
const withProduct = (id, patch) => ({ ...FIXTURE, products: FIXTURE.products.map(p => (p.id === id ? { ...p, ...patch } : p)) });

test('happy path: captures, logs the order to KV, returns the confirmation', async () => {
  const up = fakeUpstreams();
  const env = makeEnv();
  const id = await create(env);
  const { status, json } = await capture(env, id);
  assert.equal(status, 200);
  assert.deepEqual(json, { id, status: 'COMPLETED', totalCents: 7498, name: 'Ann', email: 'ann@example.com' });

  const cap = up.captures();
  assert.equal(cap.length, 1);
  assert.equal(cap[0].headers.get('PayPal-Request-Id'), id);

  const saved = env.ORDERS.store.get(`order:${id}`);
  assert.equal(saved.opts.expirationTtl, 63072000);
  const record = JSON.parse(saved.value);
  assert.equal(record.captureId, 'CAPTURE1');
  assert.equal(record.capturedAt, new Date(NOW).toISOString());
  assert.deepEqual(record.lines, [{ key: 'alpha-tee|Black, white print|S', name: 'Alpha <Tee>', color: 'Black, white print', size: 'S', qty: 2, unitCents: 3499 }]);
  assert.deepEqual(record.payer, { name: 'Ann Lee', firstName: 'Ann', email: 'ann@example.com' });
  assert.equal(record.shipTo.address.address_line_1, '1 Main St');
  assert.ok(env.ORDERS.store.has(`day:2026-10-03:${id}`));
});

test('capturing twice returns the stored result without calling PayPal again', async () => {
  const up = fakeUpstreams();
  const env = makeEnv();
  const id = await create(env);
  const first = await capture(env, id);
  const callsAfterFirst = up.calls.length;
  const second = await capture(env, id);
  assert.deepEqual(second.json, first.json);
  assert.equal(up.calls.length, callsAfterFirst);
});

test('if the KV idempotency read fails, capture still proceeds safely', async () => {
  const up = fakeUpstreams();
  const env = makeEnv();
  const id = await create(env);
  env.ORDERS.failGets = key => key.startsWith('order:');
  const { status } = await capture(env, id);
  assert.equal(status, 200);
  assert.equal(up.captures()[0].headers.get('PayPal-Request-Id'), id);
});

test('an order not created by this server is refused, logged as tag-mismatch, and alerted', async () => {
  const up = fakeUpstreams();
  const env = makeEnv();
  up.orders.set('FOREIGN12345', {
    id: 'FOREIGN12345', status: 'APPROVED',
    purchase_units: [{ custom_id: 'abc.def', amount: { currency_code: 'USD', value: '0.01' } }],
  });
  const logs = captureLogs();
  let r;
  try { r = await capture(env, 'FOREIGN12345'); } finally { logs.restore(); }
  assert.equal(r.status, 409);
  assert.equal(r.json.error.code, 'capture-refused');
  assert.equal(up.captures().length, 0);
  assert.ok(logs.lines.some(l => l.event === 'capture.refused' && l.code === 'tag-mismatch' && l.level === 'error'));
  assert.ok(up.emails.some(e => /tampering/i.test(e.subject)));
});

test('an amount changed after signing fails the tag check', async () => {
  const up = fakeUpstreams();
  const env = makeEnv();
  const id = await create(env);
  up.orders.get(id).purchase_units[0].amount.value = '0.01';
  const r = await capture(env, id);
  assert.equal(r.status, 409);
  assert.equal(up.captures().length, 0);
});

test('a replayed tag on cheaper contents is refused as reprice-mismatch', async () => {
  const up = fakeUpstreams();
  const env = makeEnv();
  const id = await create(env);
  const real = up.orders.get(id).purchase_units[0];
  up.orders.set('REPLAY123456', {
    id: 'REPLAY123456', status: 'APPROVED',
    purchase_units: [{ ...real, items: [{ ...real.items[0], quantity: '1' }] }],
  });
  const logs = captureLogs();
  let r;
  try { r = await capture(env, 'REPLAY123456'); } finally { logs.restore(); }
  assert.equal(r.status, 409);
  assert.equal(r.json.error.code, 'capture-refused');
  assert.ok(logs.lines.some(l => l.event === 'capture.refused' && l.code === 'reprice-mismatch'));
  assert.equal(up.captures().length, 0);
});

test('a tampered line price with a legit total is refused', async () => {
  const up = fakeUpstreams();
  const env = makeEnv();
  const id = await create(env);
  up.orders.get(id).purchase_units[0].items[0].unit_amount.value = '0.01';
  assert.equal((await capture(env, id)).status, 409);
  assert.equal(up.captures().length, 0);
});

test('an item that sold out after checkout started is refused with bag-changed, not charged', async () => {
  const up = fakeUpstreams();
  const env = makeEnv();
  const id = await create(env);
  const r = await capture(env, id, { data: withProduct('alpha-tee', { soldOut: true }) });
  assert.equal(r.status, 409);
  assert.equal(r.json.error.code, 'bag-changed');
  assert.equal(r.json.error.lines[0].status, 'sold-out');
  assert.equal(up.captures().length, 0);
});

test('an era that ended after checkout started is refused with bag-changed', async () => {
  const up = fakeUpstreams();
  const env = makeEnv();
  const id = await create(env);
  const ended = { ...FIXTURE, eras: FIXTURE.eras.map(e => (e.slug === 'alpha' ? { ...e, endsAt: '2026-10-03T11:00:00Z' } : e)) };
  const r = await capture(env, id, { data: ended });
  assert.equal(r.json.error.code, 'bag-changed');
  assert.equal(up.captures().length, 0);
});

test('a captured amount that differs is 502, alerted, and not logged as an order', async () => {
  const up = fakeUpstreams({ paypal: { paidValue: '1.00' } });
  const env = makeEnv();
  const id = await create(env);
  const logs = captureLogs();
  let r;
  try { r = await capture(env, id); } finally { logs.restore(); }
  assert.equal(r.status, 502);
  assert.equal(r.json.error.code, 'capture-mismatch');
  assert.ok(logs.lines.some(l => l.event === 'capture.refused' && l.code === 'amount-mismatch'));
  assert.ok(up.emails.some(e => /amount/i.test(e.subject)));
  assert.ok(!env.ORDERS.store.has(`order:${id}`));
});

test('a declined payment is 422 and does not count toward the outage alert', async () => {
  const up = fakeUpstreams({ paypal: { decline: true } });
  const env = makeEnv();
  const id = await create(env);
  const r = await capture(env, id);
  assert.equal(r.status, 422);
  assert.equal(r.json.error.code, 'payment-declined');
  assert.ok(![...env.ORDERS.store.keys()].some(k => k.startsWith('paypal-errors:')));
  assert.equal(up.emails.length, 0);
});

test('an order that is not APPROVED is refused', async () => {
  const up = fakeUpstreams();
  const env = makeEnv();
  const id = await create(env);
  up.orders.get(id).status = 'CREATED';
  const r = await capture(env, id);
  assert.equal(r.status, 409);
  assert.equal(r.json.error.code, 'capture-refused');
});

test('malformed order ids are 400 and GET is 405', async () => {
  fakeUpstreams();
  assert.equal((await capture(makeEnv(), '../x')).status, 400);
  assert.equal((await call('GET', '/api/orders/capture')).status, 405);
});

test('if writing the order to KV fails, the shopper still gets 200 and the owner gets the full record', async () => {
  const up = fakeUpstreams();
  const env = makeEnv();
  const id = await create(env);
  env.ORDERS.failPuts = key => key.startsWith('order:') || key.startsWith('day:');
  const logs = captureLogs();
  let r;
  try { r = await capture(env, id); } finally { logs.restore(); }
  assert.equal(r.status, 200);
  const failed = logs.lines.find(l => l.event === 'order.log_failed');
  assert.equal(failed.orderId, id);
  assert.ok(!JSON.stringify(logs.lines).includes('ann@example.com'));
  const mail = up.emails.find(e => /not saved/i.test(e.subject));
  assert.ok(mail.html.includes('ann@example.com'));
  assert.ok(mail.html.includes(id));
});
```

Run: `node --test tests/orders-capture.test.mjs`
Expected: FAIL, with 404 `not-found` for `/api/orders/capture`.

- [ ] **Step 2: Implement `worker/src/lib/orders.js`**

```js
import { money } from '../../../data/catalog.js';

export const ORDER_TTL = 63072000; // 2 years
export const orderKey = id => `order:${id}`;

export const findOrder = (env, id) => env.ORDERS.get(orderKey(id), 'json');

export async function saveOrder(env, record) {
  await env.ORDERS.put(orderKey(record.id), JSON.stringify(record), { expirationTtl: ORDER_TTL });
  await env.ORDERS.put(`day:${record.capturedAt.slice(0, 10)}:${record.id}`, '', { expirationTtl: ORDER_TTL });
}

export const updateOrder = (env, record) =>
  env.ORDERS.put(orderKey(record.id), JSON.stringify(record), { expirationTtl: ORDER_TTL });

export function buildRecord(captured, q, now) {
  const unit = captured.purchase_units?.[0] ?? {};
  const payerName = captured.payer?.name ?? {};
  return {
    id: captured.id,
    captureId: unit.payments?.captures?.[0]?.id ?? null,
    capturedAt: now.toISOString(),
    status: 'COMPLETED',
    lines: q.lines.map(({ key, name, color, size, qty, unitCents }) => ({ key, name, color, size, qty, unitCents })),
    subtotalCents: q.subtotalCents,
    shippingCents: q.shippingCents,
    totalCents: q.totalCents,
    payer: {
      name: [payerName.given_name, payerName.surname].filter(Boolean).join(' '),
      firstName: payerName.given_name ?? '',
      email: captured.payer?.email_address ?? '',
    },
    shipTo: { name: unit.shipping?.name?.full_name ?? '', address: unit.shipping?.address ?? {} },
    email: { customer: 'pending', owner: 'pending', attempts: 0 },
  };
}

export const addressLines = a =>
  [a.address_line_1, a.address_line_2, a.admin_area_2, a.admin_area_1, a.postal_code, a.country_code].filter(Boolean);

// Label/value rows for owner emails and alerts.
export function recordRows(r) {
  return [
    ['Order', r.id],
    ['Capture', r.captureId ?? ''],
    ['Captured at', r.capturedAt],
    ['Payer', `${r.payer.name} <${r.payer.email}>`],
    ['Ship to', [r.shipTo.name, ...addressLines(r.shipTo.address)].join(', ')],
    ...r.lines.map(l => [`${l.qty} × ${l.name}`, `${l.color} / ${l.size} at ${money(l.unitCents)}`]),
    ['Subtotal', money(r.subtotalCents)],
    ['Shipping', money(r.shippingCents)],
    ['Total', `${money(r.totalCents)} USD`],
  ];
}
```

- [ ] **Step 3: Implement `worker/src/routes/capture.js` and register it**

```js
import { json, fail, readJson } from '../lib/http.js';
import { CURRENCY, captureOrder, getOrder, verifyTag } from '../lib/paypal.js';
import { CartError, COUNTED, itemsFromUnit, quote, shippingCents, unitMatchesQuote } from '../lib/pricing.js';
import { buildRecord, findOrder, recordRows, saveOrder } from '../lib/orders.js';
import { alert } from '../lib/alerts.js';
import { paypalFailure } from './orders.js';

const ORDER_ID = /^[A-Za-z0-9]{8,32}$/;

const result = r => ({ id: r.id, status: 'COMPLETED', totalCents: r.totalCents, name: r.payer.firstName, email: r.payer.email });

function refuse(c, orderId, code) {
  const tampering = code === 'tag-mismatch';
  c.log[tampering ? 'error' : 'warn']('capture.refused', { orderId, code });
  if (tampering) c.waitUntil(alert(c, 'capture.tag-mismatch', { subject: 'Possible tampering: unsigned order capture refused', rows: [['Order', orderId]] }));
  return fail(c, 'capture-refused', 409);
}

// Replaced in Task 8 with receipt and owner emails.
export async function afterCapture(c, record, persisted) {}

// POST /api/orders/capture { orderID }
// Captures only orders this server signed, whose contents still re-price to the same amounts and are still buyable.
export async function captureRoute(req, c) {
  const body = await readJson(req);
  const orderId = body?.orderID;
  if (typeof orderId !== 'string' || !ORDER_ID.test(orderId)) return fail(c, 'invalid-order', 400);

  const existing = await findOrder(c.env, orderId).catch(() => null); // PayPal-Request-Id still prevents a double charge
  if (existing) return json(result(existing), 200, { 'Cache-Control': 'no-store' });

  let order;
  try { order = await getOrder(c.env, orderId); } catch (err) { return paypalFailure(c, err); }

  const unit = order.purchase_units?.[0];
  const amount = unit?.amount;
  if (order.purchase_units?.length !== 1 || order.status !== 'APPROVED' || amount?.currency_code !== CURRENCY) {
    return refuse(c, orderId, 'not-approved');
  }
  if (!(await verifyTag(c.env, unit.custom_id, amount.value))) return refuse(c, orderId, 'tag-mismatch');

  let q = null;
  const items = itemsFromUnit(unit);
  try { q = items && quote(c.data, c.now, items, shippingCents(c.env)); } catch (err) { if (!(err instanceof CartError)) throw err; }
  if (!q) return refuse(c, orderId, 'reprice-mismatch');
  if (q.lines.some(l => !COUNTED.has(l.status))) {
    c.log.warn('capture.refused', { orderId, code: 'bag-changed' });
    return fail(c, 'bag-changed', 409, { lines: q.lines });
  }
  if (!unitMatchesQuote(unit, q)) return refuse(c, orderId, 'reprice-mismatch');

  let done;
  try { done = await captureOrder(c.env, orderId); } catch (err) { return paypalFailure(c, err); }

  const paid = done.purchase_units?.[0]?.payments?.captures?.[0]?.amount;
  if (done.status !== 'COMPLETED' || paid?.value !== amount.value || paid?.currency_code !== CURRENCY) {
    c.log.error('capture.refused', { orderId, code: 'amount-mismatch', expected: amount.value, paid: paid?.value ?? null, paypalStatus: done.status });
    c.waitUntil(alert(c, 'capture.amount-mismatch', {
      subject: `Captured amount mismatch on order ${orderId}`,
      rows: [['Order', orderId], ['Expected', amount.value], ['Captured', paid?.value ?? 'none'], ['PayPal status', done.status ?? '']],
    }));
    return fail(c, 'capture-mismatch', 502);
  }

  const record = buildRecord(done, q, c.now);
  let persisted = true;
  try {
    await saveOrder(c.env, record);
  } catch {
    persisted = false;
    c.log.error('order.log_failed', { orderId });
    c.waitUntil(alert(c, 'order.log_failed', { subject: `Paid order ${orderId} was not saved`, rows: recordRows(record), dedupe: false }));
  }
  c.log.info('order.captured', { orderId, totalCents: record.totalCents });
  c.waitUntil(afterCapture(c, record, persisted));
  return json(result(record), 200, { 'Cache-Control': 'no-store' });
}
```

In `worker/src/index.js`, add `import { captureRoute } from './routes/capture.js';` and append to `ROUTES`:
```js
  ['POST', /^\/api\/orders\/capture$/, captureRoute],
```

Run: `node --test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add worker/src/lib/orders.js worker/src/routes/capture.js worker/src/index.js tests/orders-capture.test.mjs
git commit -m "Capture PayPal orders with re-pricing, buyable check and KV order log"
```

---

### Task 8: Receipt and owner emails with cron retry

**Files:**
- Create: `worker/src/emails/receipt.js`, `worker/src/emails/owner.js`, `worker/src/lib/delivery.js`, `tests/emails.test.mjs`
- Modify: `worker/src/routes/capture.js` (`afterCapture`), `worker/src/index.js` (`scheduled`), `worker/wrangler.toml` (cron)

**Interfaces:**
- Consumes: `sendEmail`, `alert` (Task 5); `findOrder`, `updateOrder`, `recordRows`, `addressLines` (Task 7); `esc`, `money`, `layout`, `table` (Task 5).
- Produces:
  - `receiptEmail(record) → { subject, html }`, `ownerEmail(record) → { subject, html }`
  - `BACKOFF_MINUTES = [15, 30, 60, 120, 240]`
  - `deliverOrderEmails(c, record) → Promise<boolean>`, which sends unsent recipients, mutates `record.email` and returns true when both are sent
  - `sendOrderEmails(c, record, { persisted }) → Promise<void>`
  - `retryEmails(c) → Promise<void>`
- Retry key `email-retry:<orderId>` holds `{ retries, nextAt }`, where `nextAt` is epoch ms.

- [ ] **Step 1: Write the failing tests**

`tests/emails.test.mjs`:
```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { call, makeEnv, makeCtx, fakeUpstreams, captureLogs } from './helpers/fake-env.mjs';
import { FIXTURE, NOW } from './helpers/fixture.mjs';
import { createApp } from '../worker/src/index.js';

const MIN = 60_000;
const item = { id: 'alpha-tee', color: 'Black, white print', size: 'S', qty: 2 };

async function buy(env) {
  const id = (await call('POST', '/api/orders', { body: { items: [item] }, env })).json.id;
  await call('POST', '/api/orders/capture', { body: { orderID: id }, env });
  return id;
}

async function cron(env, at) {
  const app = createApp({ data: FIXTURE, clock: () => at });
  const ctx = makeCtx();
  await app.scheduled({ cron: '*/15 * * * *', scheduledTime: at }, env, ctx);
  await ctx.settle();
}

const record = (env, id) => JSON.parse(env.ORDERS.store.get(`order:${id}`).value);
const retryState = (env, id) => {
  const v = env.ORDERS.store.get(`email-retry:${id}`);
  return v && JSON.parse(v.value);
};

test('after capture the customer gets a receipt and the owner a notification', async () => {
  const up = fakeUpstreams();
  const env = makeEnv();
  const id = await buy(env);
  const customer = up.emails.find(e => e.to[0] === 'ann@example.com');
  const owner = up.emails.find(e => e.to[0] === 'owner@evincus.shop');
  assert.equal(customer.subject, `Your Evincus order ${id}`);
  assert.equal(customer.idempotencyKey, `${id}-customer`);
  assert.ok(customer.html.includes('Alpha &lt;Tee&gt;'));
  assert.ok(!customer.html.includes('<Tee>'));
  assert.ok(customer.html.includes('$74.98'));
  assert.ok(customer.html.includes('1 Main St'));
  assert.match(owner.subject, new RegExp(`New order ${id}: \\$74\\.98`));
  assert.equal(owner.idempotencyKey, `${id}-owner`);
  assert.ok(owner.html.includes('ann@example.com'));
  assert.deepEqual(record(env, id).email, { customer: 'sent', owner: 'sent', attempts: 1 });
  assert.equal(retryState(env, id), undefined);
});

test('a failed receipt is queued for retry 15 minutes later; the owner email still goes', async () => {
  const up = fakeUpstreams({ resend: { fail: b => b.to[0] === 'ann@example.com' } });
  const env = makeEnv();
  const id = await buy(env);
  assert.deepEqual(record(env, id).email, { customer: 'failed', owner: 'sent', attempts: 1 });
  assert.deepEqual(retryState(env, id), { retries: 0, nextAt: NOW + 15 * MIN });
  assert.equal(up.emails.length, 1);
});

test('a capture with no payer email still succeeds; the owner is notified and the receipt retried', async () => {
  const up = fakeUpstreams({ paypal: { payer: { name: { given_name: 'Ann' } } } });
  const env = makeEnv();
  const id = await buy(env);
  assert.equal(record(env, id).email.customer, 'failed');
  assert.ok(up.emails.some(e => e.to[0] === 'owner@evincus.shop'));
  assert.ok(retryState(env, id));
});

test('cron waits until the retry is due, then resends only what failed', async () => {
  let failing = true;
  const up = fakeUpstreams({ resend: { fail: b => failing && b.to[0] === 'ann@example.com' } });
  const env = makeEnv();
  const id = await buy(env);
  await cron(env, NOW + 14 * MIN);
  assert.equal(up.emails.length, 1);
  failing = false;
  await cron(env, NOW + 15 * MIN);
  assert.deepEqual(up.emails.map(e => e.to[0]), ['owner@evincus.shop', 'ann@example.com']);
  assert.deepEqual(record(env, id).email, { customer: 'sent', owner: 'sent', attempts: 2 });
  assert.equal(retryState(env, id), undefined);
});

test('retries back off 30, 60, 120, 240 minutes, then give up with an alert', async () => {
  const up = fakeUpstreams({ resend: { fail: b => b.to[0] === 'ann@example.com' } });
  const env = makeEnv();
  const id = await buy(env);
  let at = NOW + 15 * MIN;
  for (const wait of [30, 60, 120, 240]) {
    await cron(env, at);
    const s = retryState(env, id);
    assert.equal(s.nextAt, at + wait * MIN);
    at = s.nextAt;
  }
  const logs = captureLogs();
  try { await cron(env, at); } finally { logs.restore(); }
  assert.equal(retryState(env, id), undefined);
  assert.ok(logs.lines.some(l => l.event === 'email.gave_up' && l.orderId === id));
  assert.ok(up.emails.some(e => e.to[0] === 'owner@evincus.shop' && /Receipt not delivered/.test(e.subject)));
  assert.equal(record(env, id).email.attempts, 6);
});

test('cron drops retry keys whose order record is gone', async () => {
  fakeUpstreams();
  const env = makeEnv();
  await env.ORDERS.put('email-retry:GHOST1234', JSON.stringify({ retries: 0, nextAt: NOW }));
  await cron(env, NOW);
  assert.equal(env.ORDERS.store.has('email-retry:GHOST1234'), false);
});

test('a full purchase with emails writes no PII to logs', async () => {
  fakeUpstreams({ resend: { fail: b => b.to[0] === 'ann@example.com' } });
  const env = makeEnv();
  const logs = captureLogs();
  try {
    await buy(env);
    await cron(env, NOW + 15 * MIN);
  } finally { logs.restore(); }
  const all = JSON.stringify(logs.lines);
  for (const pii of ['ann@example.com', 'Ann Lee', '1 Main St', 'Kingston']) assert.ok(!all.includes(pii), pii);
});
```

Run: `node --test tests/emails.test.mjs`
Expected: FAIL (no emails sent; `app.scheduled` is not a function).

- [ ] **Step 2: Implement the templates**

`worker/src/emails/receipt.js`:
```js
import { esc, money, layout } from './html.js';
import { addressLines } from '../lib/orders.js';

export function receiptEmail(r) {
  const items = r.lines.map(l =>
    `<tr><td>${esc(l.name)}<br>${esc(l.color)} / ${esc(l.size)}</td><td align="right">${l.qty} × ${money(l.unitCents)}</td></tr>`).join('');
  const ship = [r.shipTo.name, ...addressLines(r.shipTo.address)].filter(Boolean).map(esc).join('<br>');
  return {
    subject: `Your Evincus order ${r.id}`,
    html: layout('Thanks for your order', `
<p>Your payment went through and your order is in.</p>
<table width="100%">
${items}
<tr><td>Subtotal</td><td align="right">${money(r.subtotalCents)}</td></tr>
<tr><td>Shipping</td><td align="right">${r.shippingCents ? money(r.shippingCents) : 'Free'}</td></tr>
<tr><th align="left">Total</th><th align="right">${money(r.totalCents)} USD</th></tr>
</table>
${ship ? `<h2>Shipping to</h2><p>${ship}</p>` : ''}
<p>Order reference: ${esc(r.id)}</p>
<p>Questions about your order? DM @evincus.sw on Instagram with your order reference.</p>`),
  };
}
```

`worker/src/emails/owner.js`:
```js
import { money, layout, table } from './html.js';
import { recordRows } from '../lib/orders.js';

export function ownerEmail(r) {
  return {
    subject: `New order ${r.id}: ${money(r.totalCents)}`,
    html: layout(`New order ${r.id}`, table(recordRows(r))),
  };
}
```

- [ ] **Step 3: Implement `worker/src/lib/delivery.js`**

```js
import { sendEmail } from './email.js';
import { alert } from './alerts.js';
import { findOrder, updateOrder } from './orders.js';
import { receiptEmail } from '../emails/receipt.js';
import { ownerEmail } from '../emails/owner.js';

export const BACKOFF_MINUTES = [15, 30, 60, 120, 240];
const retryKey = id => `email-retry:${id}`;
const MIN = 60_000;

// Sends whichever of the two emails isn't sent yet and updates record.email. True when both are sent.
export async function deliverOrderEmails(c, record) {
  const attempt = record.email.attempts + 1;
  const jobs = [
    ['customer', record.payer.email, () => receiptEmail(record)],
    ['owner', c.env.OWNER_EMAIL, () => ownerEmail(record)],
  ];
  for (const [recipient, to, build] of jobs) {
    if (record.email[recipient] === 'sent') continue;
    try {
      await sendEmail(c.env, { to, ...build(), idempotencyKey: `${record.id}-${recipient}` });
      record.email[recipient] = 'sent';
      c.log.info('email.sent', { orderId: record.id, recipient, attempts: attempt });
    } catch (err) {
      record.email[recipient] = 'failed';
      c.log.warn('email.failed', { orderId: record.id, recipient, attempts: attempt, message: String(err?.message ?? err) });
    }
  }
  record.email.attempts = attempt;
  return record.email.customer === 'sent' && record.email.owner === 'sent';
}

// First delivery, right after capture. Queues a retry only for orders that made it into KV.
export async function sendOrderEmails(c, record, { persisted }) {
  try {
    const done = await deliverOrderEmails(c, record);
    if (!persisted) return;
    await updateOrder(c.env, record);
    if (!done) await c.env.ORDERS.put(retryKey(record.id), JSON.stringify({ retries: 0, nextAt: +c.now + BACKOFF_MINUTES[0] * MIN }));
  } catch (err) {
    c.log.error('email.failed', { orderId: record.id, message: String(err?.message ?? err) });
  }
}

async function retryOne(c, id) {
  const key = retryKey(id);
  const state = await c.env.ORDERS.get(key, 'json');
  if (!state || state.nextAt > +c.now) return;
  const record = await findOrder(c.env, id);
  if (!record) { await c.env.ORDERS.delete(key); return; }

  const done = await deliverOrderEmails(c, record);
  await updateOrder(c.env, record);
  if (done) { await c.env.ORDERS.delete(key); return; }

  const retries = state.retries + 1;
  if (retries >= BACKOFF_MINUTES.length) {
    c.log.error('email.gave_up', { orderId: id, attempts: record.email.attempts });
    await c.env.ORDERS.delete(key);
    await alert(c, 'email.gave_up', {
      subject: `Receipt not delivered for order ${id}`,
      rows: [['Order', id], ['Customer email', record.email.customer], ['Owner email', record.email.owner], ['Attempts', String(record.email.attempts)]],
    });
    return;
  }
  await c.env.ORDERS.put(key, JSON.stringify({ retries, nextAt: +c.now + BACKOFF_MINUTES[retries] * MIN }));
}

// Cron: every 15 minutes, retry due email deliveries. One bad order never blocks the rest.
export async function retryEmails(c) {
  let cursor;
  do {
    const page = await c.env.ORDERS.list({ prefix: 'email-retry:', cursor });
    for (const { name } of page.keys) {
      const id = name.slice('email-retry:'.length);
      try { await retryOne(c, id); } catch (err) { c.log.error('email.failed', { orderId: id, message: String(err?.message ?? err) }); }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
}
```

- [ ] **Step 4: Wire capture, the cron handler and the cron trigger**

In `worker/src/routes/capture.js`, add `import { sendOrderEmails } from '../lib/delivery.js';` and replace the placeholder:
```js
// Replaced in Task 8 with receipt and owner emails.
export async function afterCapture(c, record, persisted) {}
```
with:
```js
export function afterCapture(c, record, persisted) {
  return sendOrderEmails(c, record, { persisted });
}
```

In `worker/src/index.js`, add `import { retryEmails } from './lib/delivery.js';` and add this method after `fetch` in the object returned by `createApp`:
```js
    async scheduled(event, env, ctx) {
      const log = createLogger({ route: 'cron' });
      const now = clock();
      const c = { env, data, now: new Date(now), reqId: `cron-${now}`, log, waitUntil: p => ctx.waitUntil(p), params: [] };
      ctx.waitUntil(retryEmails(c).catch(err => log.error('unhandled', { message: String(err?.message ?? err) })));
    },
```

Append to `worker/wrangler.toml`:
```toml
[triggers]
crons = ["*/15 * * * *"]
```

Run: `node --test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/src/emails worker/src/lib/delivery.js worker/src/routes/capture.js worker/src/index.js worker/wrangler.toml tests/emails.test.mjs
git commit -m "Email receipts and owner notifications with cron retry and backoff"
```

---

### Task 9: Client error beacon with rate limiting

**Files:**
- Create: `worker/src/routes/beacon.js`, `tests/beacon.test.mjs`
- Modify: `worker/src/index.js`, `worker/wrangler.toml`

**Interfaces:**
- Consumes: `fail`, `readJson` (Task 3); `env.BEACON_LIMIT.limit({ key }) → { success }`.
- Produces: `beacon(req, c)` → 204, 400 `invalid-beacon`, 413 or 429. It logs `client.error` with `clientEvent`, `code`, `clientRoute` and `clientReqId`.
- `BEACON_EVENTS`: `paypal-sdk-failed`, `quote-failed`, `order-create-failed`, `capture-failed`, `api-unreachable`.

- [ ] **Step 1: Write the failing tests**

`tests/beacon.test.mjs`:
```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { call, makeEnv, captureLogs } from './helpers/fake-env.mjs';

const send = (body, env = makeEnv(), headers = { 'CF-Connecting-IP': '1.2.3.4' }) =>
  call('POST', '/api/beacon', { raw: typeof body === 'string' ? body : JSON.stringify(body), env, headers });

test('a valid beacon is logged as client.error and returns 204', async () => {
  const logs = captureLogs();
  let r;
  try { r = await send({ event: 'quote-failed', code: 'network', route: '#/checkout', reqId: 'abc' }); } finally { logs.restore(); }
  assert.equal(r.status, 204);
  const line = logs.lines.find(l => l.event === 'client.error');
  assert.deepEqual([line.level, line.clientEvent, line.code, line.clientRoute, line.clientReqId], ['warn', 'quote-failed', 'network', '#/checkout', 'abc']);
});

test('beacons sent as text/plain (navigator.sendBeacon) are accepted', async () => {
  const r = await call('POST', '/api/beacon', { raw: JSON.stringify({ event: 'api-unreachable' }), headers: { 'Content-Type': 'text/plain' } });
  assert.equal(r.status, 204);
});

test('unknown events, extra fields, long or non-string fields are 400', async () => {
  for (const body of [{ event: 'hack' }, { event: 'quote-failed', extra: 1 }, { event: 'quote-failed', code: 'x'.repeat(201) },
    { event: 'quote-failed', route: 5 }, [], 'nope']) {
    const r = await send(body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.json.error.code, 'invalid-beacon');
  }
});

test('beacons over 2 KB are 413', async () => {
  const r = await send({ event: 'quote-failed', code: 'x'.repeat(2100) });
  assert.equal(r.status, 413);
});

test('more than 10 beacons a minute from one IP are 429', async () => {
  const env = makeEnv();
  const statuses = [];
  for (let i = 0; i < 11; i++) statuses.push((await send({ event: 'api-unreachable' }, env)).status);
  assert.deepEqual(statuses, [...Array(10).fill(204), 429]);
  assert.equal((await send({ event: 'api-unreachable' }, env, { 'CF-Connecting-IP': '5.6.7.8' })).status, 204);
});
```

Run: `node --test tests/beacon.test.mjs`
Expected: FAIL (404).

- [ ] **Step 2: Implement and register**

`worker/src/routes/beacon.js`:
```js
import { fail, readJson } from '../lib/http.js';

export const BEACON_EVENTS = new Set(['paypal-sdk-failed', 'quote-failed', 'order-create-failed', 'capture-failed', 'api-unreachable']);
const OPTIONAL = ['code', 'route', 'reqId'];
const ALLOWED = new Set(['event', ...OPTIONAL]);

// Checkout-only error reports from the browser. Fixed schema, small, rate limited per IP.
export async function beacon(req, c) {
  const ip = req.headers.get('CF-Connecting-IP') ?? 'unknown';
  const { success } = await c.env.BEACON_LIMIT.limit({ key: ip });
  if (!success) return fail(c, 'rate-limited', 429);

  const body = await readJson(req, 2048);
  const valid = body && typeof body === 'object' && !Array.isArray(body) &&
    BEACON_EVENTS.has(body.event) &&
    Object.keys(body).every(k => ALLOWED.has(k)) &&
    OPTIONAL.every(k => body[k] === undefined || (typeof body[k] === 'string' && body[k].length <= 200));
  if (!valid) return fail(c, 'invalid-beacon', 400);

  c.log.warn('client.error', { clientEvent: body.event, code: body.code, clientRoute: body.route, clientReqId: body.reqId });
  return new Response(null, { status: 204 });
}
```

In `worker/src/index.js`, add `import { beacon } from './routes/beacon.js';` and append to `ROUTES`:
```js
  ['POST', /^\/api\/beacon$/, beacon],
```

Append to `worker/wrangler.toml`:
```toml
[[ratelimits]]
name = "BEACON_LIMIT"
namespace_id = "1001"

  [ratelimits.simple]
  limit = 10
  period = 60
```

Run: `node --test`
Expected: PASS.

Run: `npx wrangler deploy --config worker/wrangler.toml --dry-run --outdir .wrangler/dry`
Expected: no config errors. If the installed wrangler rejects `[[ratelimits]]`, run `npx wrangler docs rate-limit` (or check the Workers Rate Limiting docs) and use the binding syntax that version accepts, keeping the binding name `BEACON_LIMIT`, limit 10, period 60.

- [ ] **Step 3: Commit**

```bash
git add worker/src/routes/beacon.js worker/src/index.js worker/wrangler.toml tests/beacon.test.mjs
git commit -m "Add rate-limited checkout error beacon"
```

---

### Task 10: Site loads the catalog from the API with static fallback

**Files:**
- Create: `assets/js/api.js`
- Modify: `assets/js/store.js`, `assets/js/config.example.js`, `assets/js/config.js` (local, gitignored)

**Interfaces:**
- Consumes: Worker `GET /api/eras` and `GET /api/eras/:slug` (Task 3), `POST /api/beacon` (Task 9).
- Produces (`assets/js/api.js`):
  - `ApiError` (`.status`, `.code`, `.reqId`, `.body`, `.message`, which is shopper-readable)
  - `api(method, path, body?) → Promise<data>`
  - `beacon(event, fields?)`, `beaconOnce(event, fields?)` (once per session)
- `store.js`: same exports as in Task 2. `isLive()` is true only when the catalog came from the API. In fallback, every product has `buyable: false`.

- [ ] **Step 1: Add `API_BASE` to config**

`assets/js/config.example.js`, replacing the `SHIPPING_USD` block (shipping now comes from the server quote):
```js
// Copy this file to config.js and fill in your values.
// config.js is gitignored; CI writes it from repository variables at deploy.

// PayPal Client ID — developer.paypal.com → Apps & Credentials.
// Use the Sandbox ID while testing, the Live ID in production. Must match the Worker's PAYPAL_CLIENT_ID.
export const PAYPAL_CLIENT_ID = 'test';

// Where the API runs, with no trailing slash. Local: http://localhost:8787.
// Production: https://api.evincus.shop (or the workers.dev URL). Same-origin hosting later: ''.
export const API_BASE = 'http://localhost:8787';
```

Update your local `assets/js/config.js` to export `PAYPAL_CLIENT_ID` and `API_BASE = 'http://localhost:8787'`. Keep `SHIPPING_USD` there until Task 11 removes `totals.js`.

- [ ] **Step 2: Create `assets/js/api.js`**

```js
import { API_BASE } from './config.js';

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error?.message ?? "Can't reach the store right now. Check your connection and try again.");
    this.status = status;
    this.code = body?.error?.code ?? 'network';
    this.reqId = body?.error?.requestId ?? null;
    this.body = body;
  }
}

export async function api(method, path, body) {
  let res;
  try {
    res = await fetch(API_BASE + path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, null);
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

// Fire-and-forget checkout error report. text/plain avoids a CORS preflight.
export function beacon(event, fields = {}) {
  try {
    const body = JSON.stringify({ event, route: (location.hash || '#/').slice(0, 200), ...fields });
    const blob = new Blob([body], { type: 'text/plain' });
    if (!navigator.sendBeacon?.(API_BASE + '/api/beacon', blob)) {
      fetch(API_BASE + '/api/beacon', { method: 'POST', body: blob, keepalive: true }).catch(() => {});
    }
  } catch { /* reporting must never break the page */ }
}

export function beaconOnce(event, fields) {
  try {
    const key = `evincus_beacon_${event}`;
    if (sessionStorage.getItem(key)) return;
    sessionStorage.setItem(key, '1');
  } catch { /* storage blocked: report anyway */ }
  beacon(event, fields);
}
```

The server rejects `null` beacon fields, so callers pass `reqId` only when it exists: `beacon('quote-failed', { code: err.code, ...(err.reqId ? { reqId: err.reqId } : {}) })`. Task 11 follows this pattern.

- [ ] **Step 3: Make `store.js` API-first**

Replace `loadCatalog` and the import lines in `assets/js/store.js`:
```js
// The site's copy of the catalog. Loaded once at startup; pages read it synchronously after that.
// The API is the source of truth. If it can't be reached, the static JSON keeps browsing working,
// with every product marked unbuyable so checkout stays off.
import { publicView, findProduct as find } from '../../data/catalog.js';
import { api, beaconOnce } from './api.js';

let state = { eras: [], products: [], site: { categories: [], lookbook: [], careNote: '' }, live: false };

async function fetchJson(file) {
  const res = await fetch(new URL(`../../data/${file}`, import.meta.url));
  if (!res.ok) throw new Error(`${file} failed to load (${res.status})`);
  return res.json();
}

async function fromApi() {
  const list = await api('GET', '/api/eras');
  const released = list.eras.filter(e => e.status !== 'upcoming');
  const details = await Promise.all(released.map(e => api('GET', `/api/eras/${encodeURIComponent(e.slug)}`)));
  const bySlug = new Map(details.map(({ products, ...era }) => [era.slug, era]));
  return {
    eras: list.eras.map(e => ({ ...e, ...(bySlug.get(e.slug) ?? {}) })),
    products: details.flatMap(d => d.products),
  };
}

async function fromStatic() {
  const [eras, products] = await Promise.all([fetchJson('eras.json'), fetchJson('products.json')]);
  const view = publicView({ eras, products }, new Date());
  return { eras: view.eras, products: view.products.map(p => ({ ...p, buyable: false })) };
}

export async function loadCatalog() {
  const site = await fetchJson('site.json');
  try {
    state = { ...(await fromApi()), site, live: true };
  } catch {
    beaconOnce('api-unreachable');
    state = { ...(await fromStatic()), site, live: false };
  }
}
```
The getters (`eras`, `products`, `site`, `isLive`, `findProduct`, `eraName`) stay unchanged.

- [ ] **Step 4: Verify both modes**

Start the API (`npm run dev:api`) and a static server (`npx --yes http-server -p 5180 -c-1 .`) in the background.

1. Open `http://localhost:5180/index.store.html`. In devtools' network panel you should see `GET http://localhost:8787/api/eras` plus three `/api/eras/<slug>` calls, all 200, and the shop should look identical to Task 2.
2. Stop the API and reload. The shop still renders from `data/*.json`, the console has no uncaught errors, and only one `api-unreachable` beacon attempt is made per session (it fails silently while the API is down).

Run: `node --test`
Expected: PASS (no site tests, so this confirms nothing else broke).

- [ ] **Step 5: Commit**

```bash
git add assets/js/api.js assets/js/store.js assets/js/config.example.js
git commit -m "Load the site catalog from the API with a static fallback"
```

---

### Task 11: Bag quote in the drawer, checkout and PayPal through the Worker

**Files:**
- Create: `assets/js/quote.js`
- Modify: `assets/js/cart.js`, `assets/js/app.js`, `assets/js/paypal.js`, `pages/checkout.js`, `pages/thank-you.js`, `assets/css/main.css`, `assets/js/config.example.js`
- Delete: `assets/js/totals.js`

**Interfaces:**
- Consumes: `api`, `ApiError`, `beacon` (Task 10); `POST /api/bag/quote`, `/api/orders`, `/api/orders/capture` (Tasks 4, 6, 7).
- Produces (`assets/js/quote.js`):
  - `current() → { status: 'idle'|'loading'|'ready'|'error', quote, error }`
  - `refreshQuote() → Promise<state>`, `scheduleQuote()` (300 ms debounce), `onQuote(fn)`
  - `isCheckoutReady() → boolean`, `unavailableKeys() → string[]`
- Produces (`cart.js`): `rawItems() → {key,id,color,size,qty}[]`, `removeMany(keys)`.

- [ ] **Step 1: Extend `assets/js/cart.js`**

Add after `export function count()…`:
```js
// Every stored line, valid or not, so the server can say what's wrong with each one.
export function rawItems() {
  return items
    .filter(i => typeof i.id === 'string' && typeof i.color === 'string' && typeof i.size === 'string' && Number.isInteger(i.qty) && i.qty >= 1)
    .map(({ key, id, color, size, qty }) => ({ key, id, color, size, qty }));
}
```
Add after `export function remove…`:
```js
export function removeMany(keys) { const drop = new Set(keys); items = items.filter(i => !drop.has(i.key)); save(); }
```
Change `count()` to count raw lines, so the badge matches what the drawer shows:
```js
export function count()    { return rawItems().reduce((n, l) => n + l.qty, 0); }
```

- [ ] **Step 2: Create `assets/js/quote.js`**

```js
// The server's view of the bag: prices, availability and totals. The bag UI and checkout render from this.
import { api, beacon } from './api.js';
import * as cart from './cart.js';

const COUNTED = new Set(['ok', 'qty-capped']);
let state = { status: 'idle', quote: null, error: null };
const listeners = new Set();
let timer = null;
let seq = 0;

const emit = () => listeners.forEach(fn => fn(state));

export const current = () => state;
export const onQuote = fn => { listeners.add(fn); };
export const isCheckoutReady = () => state.status === 'ready' && state.quote?.checkoutReady === true;
export const unavailableKeys = () => (state.quote?.lines ?? []).filter(l => !COUNTED.has(l.status)).map(l => l.key);

export async function refreshQuote() {
  clearTimeout(timer);
  const mine = ++seq;
  const items = cart.rawItems().map(({ id, color, size, qty }) => ({ id, color, size, qty }));
  if (!items.length) {
    state = { status: 'ready', quote: null, error: null };
    emit();
    return state;
  }
  state = { ...state, status: 'loading' };
  emit();
  try {
    const quote = await api('POST', '/api/bag/quote', { items });
    if (mine === seq) state = { status: 'ready', quote, error: null };
  } catch (err) {
    if (mine === seq) {
      state = { status: 'error', quote: null, error: err };
      beacon('quote-failed', { code: err.code, ...(err.reqId ? { reqId: err.reqId } : {}) });
    }
  }
  if (mine === seq) emit();
  return state;
}

export function scheduleQuote() {
  clearTimeout(timer);
  timer = setTimeout(refreshQuote, 300);
}
```

- [ ] **Step 3: Render the bag from the quote in `assets/js/app.js`**

Add the import after `import * as cart from './cart.js';`:
```js
import * as quote from './quote.js';
```

Replace the whole `renderBag()` function with:
```js
const STATUS_TEXT = {
  'sold-out': 'Sold out',
  'not-released': 'Not released yet',
  'era-ended': 'No longer sold',
  'unknown-item': 'No longer available',
  'qty-capped': 'Limit of 10 per item',
};
const BUYABLE = new Set(['ok', 'qty-capped', undefined]);

function lineHtml(l) {
  const canChange = BUYABLE.has(l.status);
  const name = l.name ?? 'Item no longer available';
  return `
    <div class="line${canChange ? '' : ' is-unavailable'}" data-key="${esc(l.key)}">
      ${l.image ? `<a href="#/product/${esc(l.id)}" class="line-img"><img src="${esc(l.image)}" alt="" loading="lazy"></a>` : '<span class="line-img"></span>'}
      <div class="line-info">
        ${l.name ? `<a href="#/product/${esc(l.id)}" class="line-name">${esc(name)}</a>` : `<span class="line-name">${esc(name)}</span>`}
        <div class="line-meta">${esc(l.color)}, size ${esc(l.size)}</div>
        ${STATUS_TEXT[l.status] ? `<div class="line-status">${STATUS_TEXT[l.status]}</div>` : ''}
        ${canChange ? `
        <div class="qty" aria-label="Quantity">
          <button type="button" data-act="dec" aria-label="Remove one">−</button>
          <span>${l.qty}</span>
          <button type="button" data-act="inc" aria-label="Add one">+</button>
        </div>` : ''}
      </div>
      <div class="line-end">
        <span>${l.totalCents !== undefined && canChange ? money(l.totalCents) : ''}</span>
        <button type="button" class="text-btn" data-act="remove">Remove</button>
      </div>
    </div>`;
}

function footHtml(s) {
  if (s.status === 'error') {
    return `
    <p class="bag-notice" role="status">Prices and availability can't be checked right now, so checkout is paused. Try again in a minute.</p>
    <button type="button" class="btn btn-line btn-block" data-act="retry-quote">Check again</button>`;
  }
  if (s.status !== 'ready' || !s.quote) {
    return `
    <div class="sum-row"><span>Subtotal</span><span>${money(cart.subtotal())}</span></div>
    <p class="bag-notice" role="status">Checking prices and availability…</p>
    <button type="button" class="btn btn-light btn-block" disabled>Check out</button>`;
  }
  const q = s.quote;
  return `
    ${q.checkoutReady ? '' : `
    <p class="bag-notice" role="status">Some items can't be bought. Remove them to check out.</p>
    <button type="button" class="btn btn-line btn-block" data-act="remove-unavailable">Remove unavailable items</button>`}
    <div class="sum-row"><span>Subtotal</span><span>${money(q.subtotalCents)}</span></div>
    ${q.checkoutReady
      ? '<a href="#/checkout" class="btn btn-light btn-block">Check out</a>'
      : '<button type="button" class="btn btn-light btn-block" disabled>Check out</button>'}`;
}

function renderBag() {
  const n = cart.count();
  bagCount.textContent = n;
  openBtn.setAttribute('aria-label', `Bag, ${n} item${n === 1 ? '' : 's'}`);

  if (!cart.rawItems().length) {
    bagBody.innerHTML = `
      <div class="bag-empty">
        <p>Your bag is empty.</p>
        <a href="#/shop" class="btn btn-light">Shop the collection</a>
      </div>`;
    bagFoot.innerHTML = '';
    return;
  }

  const s = quote.current();
  const lines = s.status === 'ready' && s.quote ? s.quote.lines : cart.lines();
  bagBody.innerHTML = lines.map(lineHtml).join('');
  bagFoot.innerHTML = footHtml(s);
}
```

Add the `esc` import next to the existing imports:
```js
import { esc } from './ui.js';
```

Replace the `bagBody` click handler with:
```js
bagBody.addEventListener('click', e => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const key = btn.closest('.line').dataset.key;
  const line = cart.rawItems().find(l => l.key === key);
  if (!line) return;
  if (btn.dataset.act === 'inc') cart.setQty(key, line.qty + 1);
  if (btn.dataset.act === 'dec') cart.setQty(key, line.qty - 1);
  if (btn.dataset.act === 'remove') cart.remove(key);
});

bagFoot.addEventListener('click', e => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  if (btn.dataset.act === 'retry-quote') quote.refreshQuote();
  if (btn.dataset.act === 'remove-unavailable') cart.removeMany(quote.unavailableKeys());
});
```

In `openBag()`, add `quote.refreshQuote();` as the first line.

Replace the `cart.onChange(() => { renderBag(); … })` block and the boot lines at the end of the file with:
```js
cart.onChange(() => {
  renderBag();
  quote.scheduleQuote();
  bagCount.classList.remove('bump');
  void bagCount.offsetWidth;
  bagCount.classList.add('bump');
});
quote.onQuote(renderBag);

await loadCatalog();
renderBag();
quote.refreshQuote();
window.addEventListener('hashchange', navigate);
navigate();
```

- [ ] **Step 4: Rewrite `pages/checkout.js` on top of the quote**

```js
import { money } from '../data/catalog.js';
import { esc } from '../assets/js/ui.js';
import * as cart from '../assets/js/cart.js';
import * as quote from '../assets/js/quote.js';
import { initPaypalButtons } from '../assets/js/paypal.js';
import { openBag } from '../assets/js/app.js';

function summary() {
  const s = quote.current();
  if (s.status === 'error') return `<p class="bag-notice" role="status">${esc(s.error.message)} Checkout is paused until prices can be checked.</p>`;
  if (s.status !== 'ready' || !s.quote) return '<p class="bag-notice" role="status">Checking prices and availability…</p>';
  const q = s.quote;
  if (!q.checkoutReady) return '<p class="bag-notice" role="status">Some items in your bag can\'t be bought. Edit your bag to remove them, then come back.</p>';
  return `
    <ul class="summary-lines" role="list">
      ${q.lines.map(l => `
        <li class="summary-line">
          <span class="summary-img">${l.image ? `<img src="${esc(l.image)}" alt="">` : ''}<span class="summary-qty">${l.qty}</span></span>
          <span class="summary-text">
            <span class="line-name">${esc(l.name)}</span>
            <span class="line-meta">${esc(l.color)}, size ${esc(l.size)}</span>
          </span>
          <span>${money(l.totalCents)}</span>
        </li>`).join('')}
    </ul>
    <div class="sum-row"><span>Subtotal</span><span>${money(q.subtotalCents)}</span></div>
    <div class="sum-row"><span>Shipping</span><span>${q.shippingCents ? money(q.shippingCents) : 'Free'}</span></div>
    <div class="sum-row sum-total"><span>Total</span><span>${money(q.totalCents)} <small>USD</small></span></div>`;
}

let watching = false;
let paypalStarted = false;

function sync() {
  const el = document.getElementById('summary');
  if (!el) return;
  if (!cart.count()) { window.dispatchEvent(new HashChangeEvent('hashchange')); return; }
  el.innerHTML = summary();
  const ready = quote.isCheckoutReady();
  document.getElementById('payArea').hidden = !ready;
  if (ready && !paypalStarted) {
    paypalStarted = true;
    initPaypalButtons();
  }
}

export const checkout = {
  render() {
    paypalStarted = false;
    if (!cart.count()) {
      return /* html */`
<section class="page-head page-empty">
  <div class="wrap">
    <h1 class="display-lg">Checkout</h1>
    <p class="block-sub">Your bag is empty. Add a piece from the shop, then come back here to pay.</p>
    <a href="#/shop" class="btn btn-light">Shop the collection</a>
  </div>
</section>`;
    }

    return /* html */`
<section class="page-head">
  <div class="wrap"><h1 class="display-lg">Checkout</h1></div>
</section>

<section class="block block-tight">
  <div class="wrap checkout-grid">
    <div class="panel">
      <div class="panel-head">
        <h2 class="panel-title">Order summary</h2>
        <button type="button" class="text-btn" id="editBag">Edit bag</button>
      </div>
      <div id="summary">${summary()}</div>
    </div>

    <div class="panel panel-pay">
      <h2 class="panel-title">Pay</h2>
      <p class="pay-copy">Pay with your PayPal account, or choose debit or credit card to pay without one. You'll confirm your shipping address with PayPal before the payment goes through.</p>
      <p class="pay-error" id="pay-error" role="alert" hidden></p>
      <div id="payArea" hidden>
        <div id="paypal-buttons" class="paypal-box"></div>
      </div>
      <p class="pay-fine">Evincus never sees or stores your card details.</p>
    </div>
  </div>
</section>`;
  },

  init() {
    if (!cart.count()) return;
    document.getElementById('editBag').addEventListener('click', openBag);
    if (!watching) {
      watching = true;
      quote.onQuote(sync);
    }
    sync();
    quote.refreshQuote();
  },
};
```

Delete `assets/js/totals.js`. Then remove `SHIPPING_USD` from your local `assets/js/config.js` (Task 10 already removed it from `config.example.js`).

- [ ] **Step 5: Point `assets/js/paypal.js` at the Worker**

Replace the imports and the `post` function:
```js
import { PAYPAL_CLIENT_ID } from './config.js';
import * as cart from './cart.js';
import { api, beacon } from './api.js';
import { refreshQuote } from './quote.js';
```
and delete the whole `async function post(url, body) { … }`.

Add this after `showError`:
```js
const report = (event, err) => beacon(event, { code: err.code, ...(err.reqId ? { reqId: err.reqId } : {}) });

// Server messages are written for shoppers; a changed bag also refreshes the quote so the bag shows why.
function showApiError(event, err) {
  showError(err.message);
  if (err.code === 'bag-changed') refreshQuote();
  else if (err.status !== 422) report(event, err);
}
```

In `initPaypalButtons()`, in the SDK load `catch`, add `beacon('paypal-sdk-failed');` before setting `box.innerHTML`.

Replace the `window.paypal.Buttons({ … })` options object with:
```js
  let handled = false;
  window.paypal.Buttons({
    style: { layout: 'vertical', color: 'white', shape: 'rect', label: 'checkout', height: 50 },
    // Only ids, options and quantities go to the server; it prices the order and talks to PayPal.
    createOrder: () => {
      handled = false;
      showError('');
      const items = cart.rawItems().map(({ id, color, size, qty }) => ({ id, color, size, qty }));
      if (!items.length) return Promise.reject(new Error('empty-bag'));
      return api('POST', '/api/orders', { items }).then(o => o.id, err => {
        handled = true;
        showApiError('order-create-failed', err);
        throw err;
      });
    },
    onApprove: data => api('POST', '/api/orders/capture', { orderID: data.orderID })
      .then(order => {
        try {
          sessionStorage.setItem('evincus_order', JSON.stringify({ id: order.id, name: order.name, email: order.email }));
        } catch { /* confirmation page falls back to generic copy */ }
        cart.clear();
        window.location.hash = '/thank-you';
      })
      .catch(err => showApiError('capture-failed', err)),
    onCancel: () => showError(''),
    onError: err => {
      if (handled) return;
      if (err?.message === 'empty-bag') { showError('Your bag is empty. Add something before checking out.'); return; }
      console.error('PayPal error', err);
      showError('Payment failed and you were not charged. Try again, or DM @evincus.sw on Instagram.');
    },
  }).render(box);
```

- [ ] **Step 6: Thank-you copy and bag styles**

In `pages/thank-you.js`, replace:
```js
    <p class="block-sub">Your order is in. ${o.email ? `PayPal has sent a receipt to ${esc(o.email)}.` : 'PayPal has emailed you a receipt.'}</p>
```
with:
```js
    <p class="block-sub">Your order is in. ${o.email ? `We're emailing your receipt to ${esc(o.email)}.` : "We're emailing your receipt to the address on your PayPal account."}</p>
```

Append to `assets/css/main.css`:
```css
/* ── Bag availability ──────────────────────────── */
.line-status { margin-top: 6px; font-size: 13px; font-weight: 600; color: #FF9C96; }
.line.is-unavailable .line-img, .line.is-unavailable .line-name, .line.is-unavailable .line-meta { opacity: 0.55; }
.bag-notice { margin: 0 0 12px; font-size: 14px; color: var(--ash); }
.bag-notice + .btn { margin-bottom: 16px; }
```

- [ ] **Step 7: Verify end to end against the sandbox**

Create `.dev.vars` (gitignored) with the sandbox values the human supplies:
```
ENVIRONMENT=development
PAYPAL_CLIENT_SECRET=<sandbox secret>
ORDER_HMAC_KEY=<output of: node -e "console.log(crypto.randomBytes(32).toString('hex'))">
RESEND_API_KEY=<resend key>
```
Set `PAYPAL_CLIENT_ID` and `OWNER_EMAIL` in `worker/wrangler.toml` `[vars]` (or override them in `.dev.vars` for local runs). Start `npm run dev:api` and the static server.

With Playwright or a browser on `http://localhost:5180/index.store.html`:
1. Add a Catastrophe tee to the bag. The drawer shows the quote subtotal and an enabled "Check out".
2. In devtools, edit `localStorage.evincus_bag` to add `{"key":"core-x|Black|M","id":"core-x","color":"Black","size":"M","qty":1}` and reload. The drawer shows "No longer available", "Check out" is disabled, and "Remove unavailable items" fixes it.
3. Set a quantity to 11 via `localStorage`. The drawer shows "Limit of 10 per item" and the total for 10.
4. Go to checkout and pay with a PayPal sandbox buyer. You land on the thank-you page with your name, and the receipt and owner emails arrive (or show in the Resend logs).
5. Stop the API and reload. The drawer says checkout is paused, "Check out" is disabled, and checkout shows the paused notice with no PayPal buttons.

Run: `node --test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add assets/js/quote.js assets/js/cart.js assets/js/app.js assets/js/paypal.js pages/checkout.js pages/thank-you.js assets/css/main.css
git rm assets/js/totals.js
git commit -m "Quote the bag on the server and check out through the Worker"
```

---

### Task 12: Era pages and buyable states on the product page

**Files:**
- Create: `pages/era.js`
- Modify: `assets/js/app.js` (route + nav), `pages/product.js`, `assets/css/main.css`

**Interfaces:**
- Consumes: `eras()`, `products()`, `findProduct()`, `eraName()`, `isLive()` (Task 10); `card`, `esc` (`ui.js`).
- Produces: route `#/eras/:slug`; product page add-button states.

- [ ] **Step 1: Create `pages/era.js`**

```js
import { eras, products } from '../assets/js/store.js';
import { esc, card } from '../assets/js/ui.js';

const dropDate = iso => new Date(iso).toLocaleString(undefined, { dateStyle: 'long', timeStyle: 'short' });

const notFound = /* html */`
<section class="page-head page-empty">
  <div class="wrap">
    <h1 class="display-lg">Not found</h1>
    <p class="block-sub">There's no collection at this address. It may have been renamed.</p>
    <a href="#/shop" class="btn btn-light">Back to the shop</a>
  </div>
</section>`;

export const era = {
  render({ param }) {
    const e = eras().find(x => x.slug === param);
    if (!e) return notFound;

    if (e.status === 'upcoming') {
      return /* html */`
<section class="page-head era-teaser">
  <div class="wrap">
    ${e.hero ? `<figure class="era-hero"><img src="${esc(e.hero)}" alt="${esc(e.name)} collection preview"></figure>` : ''}
    <h1 class="display-lg">${esc(e.name)}</h1>
    ${e.tagline ? `<p class="era-tagline">${esc(e.tagline)}</p>` : ''}
    <p class="block-sub">Drops ${esc(dropDate(e.dropsAt))}. Follow <a class="link" href="https://www.instagram.com/evincus.sw/" target="_blank" rel="noopener noreferrer">@evincus.sw</a> to catch it first.</p>
  </div>
</section>`;
    }

    const list = products().filter(p => p.era === e.slug);
    return /* html */`
<section class="page-head">
  <div class="wrap">
    <h1 class="display-lg">${esc(e.name)}</h1>
    ${e.tagline ? `<p class="era-tagline">${esc(e.tagline)}</p>` : ''}
    ${e.story ? `<p class="block-sub">${esc(e.story)}</p>` : ''}
    ${e.status === 'archived' ? '<p class="era-note">This collection has ended. Its pieces stay here to look at, but they can\'t be bought.</p>' : ''}
  </div>
</section>

<section class="block block-tight">
  <div class="wrap">
    <div class="grid">${list.map((p, i) => card(p, { eager: i < 4 })).join('')}</div>
  </div>
</section>`;
  },
};
```

- [ ] **Step 2: Register the route**

In `assets/js/app.js`, add `import { era } from '../../pages/era.js';` and add `'/eras': era,` to `routes`. In `setActiveNav`, change the `on` line to:
```js
    const on = href === path || (href === '/shop' && (path === '/product' || path === '/eras'));
```

- [ ] **Step 3: Product page buyable states**

In `pages/product.js`, update the store import to include `isLive`:
```js
import { findProduct, products, site, eraName, isLive } from '../assets/js/store.js';
```

Add this helper above `export const product`:
```js
// What the add button says and whether it works, for the chosen colour and size.
function buttonState(p, color, size) {
  if (!isLive()) return { text: 'Checking availability', disabled: true };
  if (!p.buyable) return { text: p.soldOut ? 'Sold out' : 'No longer sold', disabled: true };
  if (!size) return { text: 'Select a size', disabled: true };
  if (p.soldOutVariants.includes(`${color}|${size}`)) return { text: 'Sold out in this size', disabled: true };
  return { text: `Add to bag, ${money(p.priceCents)}`, disabled: false };
}
```

In `render`, change the crumb to link to the era:
```js
      <a href="#/eras/${esc(p.era)}" class="crumb">${esc(eraName(p.era))} collection</a>
```
and change the add button line to:
```js
      <button type="button" class="btn btn-light btn-block" id="addBtn"${buttonState(p, color.name, null).disabled ? ' disabled' : ''}>${esc(buttonState(p, color.name, null).text)}</button>
```

In `init`, add this after the `let size = null;` line:
```js
    const syncButton = () => {
      const s = buttonState(p, color, size);
      addBtn.disabled = s.disabled;
      addBtn.textContent = s.text;
    };
```
At the end of the colour `change` handler (after the gallery swap), add `syncButton();`. Replace the size `change` handler body with:
```js
      size = r.value;
      syncButton();
```
Change the add click guard to `if (!size || addBtn.disabled) return;`.

- [ ] **Step 4: Era styles**

Append to `assets/css/main.css`:
```css
/* ── Eras ──────────────────────────────────────── */
.era-tagline { margin-top: 12px; font-size: 18px; color: var(--flash); }
.era-note { margin-top: 16px; padding: 12px 14px; border: 1px solid var(--concrete); border-radius: 3px; color: var(--ash); font-size: 14px; max-width: 60ch; }
.era-hero { margin: 0 0 24px; aspect-ratio: 16 / 9; overflow: hidden; border-radius: 3px; background: var(--asphalt); }
.era-hero img { width: 100%; height: 100%; object-fit: cover; }
```

- [ ] **Step 5: Verify**

With the API and static server running:
1. `#/eras/catastrophe` shows the name, tagline, story and the 4 products.
2. The product crumb links to the era page, and Shop stays highlighted in the nav.
3. Temporarily set `"soldOutVariants": ["Black|L"]` on `catastrophe-zip-hoodie` in `data/products.json` and restart `npm run dev:api`. Choosing Black then L shows "Sold out in this size" and the button is disabled. Revert the edit.
4. Temporarily set `"dropsAt": "2030-01-01T00:00:00Z"` on `reflection` in `data/eras.json` and restart the API. `#/eras/reflection` shows the teaser with the local drop date, the Reflection products are gone from Shop, and `#/product/reflection-track-jacket` shows "Not found". Revert the edit.
5. Stop the API: the product page button reads "Checking availability" and is disabled.
6. At 375 px width, the era page and teaser have no horizontal scroll.

Run: `node --test`
Expected: PASS (`data.test.mjs` confirms the reverted JSON is valid).

- [ ] **Step 6: Commit**

```bash
git add pages/era.js assets/js/app.js pages/product.js assets/css/main.css
git commit -m "Add era pages and availability states on the product page"
```

---

### Task 13: Cloudflare resources, CI deploy, staging run

**Files:**
- Create: `.github/workflows/deploy.yml`
- Modify: `worker/wrangler.toml`

**Interfaces:**
- Consumes: everything above.
- Produces: production and staging Workers; a GitHub Pages deploy that only runs after the Worker deploy succeeds.

This task needs the human for Cloudflare login, secrets and repository settings. Each step below says who does it.

- [ ] **Step 1 (human): Log in to Cloudflare and create the KV namespaces**

Run: `npx wrangler login`, then:
```bash
npx wrangler kv namespace create ORDERS --config worker/wrangler.toml
npx wrangler kv namespace create ORDERS_STAGING --config worker/wrangler.toml
```
Copy both printed `id` values.

- [ ] **Step 2: Finish `worker/wrangler.toml`**

Set the production KV `id` to the `ORDERS` id. Set `PAYPAL_CLIENT_ID` (sandbox for now) and `OWNER_EMAIL` to the values the human supplied. If `evincus.shop` is on Cloudflare DNS, add this under `workers_dev = true`:
```toml
routes = [{ pattern = "api.evincus.shop", custom_domain = true }]
```

Append the staging environment (`vars`, `kv_namespaces` and `ratelimits` are not inherited, so they are repeated):
```toml
[env.staging]
name = "evincus-api-staging"
routes = []

[env.staging.vars]
ENVIRONMENT = "staging"
PAYPAL_ENV = "sandbox"
PAYPAL_CLIENT_ID = "<same sandbox client id>"
SHIPPING_USD = "0"
OWNER_EMAIL = "<owner email>"
EMAIL_FROM = "Evincus <orders@evincus.shop>"
ALLOWED_ORIGINS = "https://jojo6550.github.io"
COMMIT_SHA = "dev"

[[env.staging.kv_namespaces]]
binding = "ORDERS"
id = "<ORDERS_STAGING id>"

[[env.staging.ratelimits]]
name = "BEACON_LIMIT"
namespace_id = "1002"

  [env.staging.ratelimits.simple]
  limit = 10
  period = 60
```

Run: `npx wrangler deploy --config worker/wrangler.toml --dry-run --outdir .wrangler/dry` and the same with `--env staging`.
Expected: both succeed.

- [ ] **Step 3 (human): Set the Worker secrets**

```bash
for env in "" "--env staging"; do
  npx wrangler secret put PAYPAL_CLIENT_SECRET --config worker/wrangler.toml $env
  npx wrangler secret put ORDER_HMAC_KEY --config worker/wrangler.toml $env
  npx wrangler secret put RESEND_API_KEY --config worker/wrangler.toml $env
done
```
Use a different `ORDER_HMAC_KEY` for each environment, generated with `node -e "console.log(crypto.randomBytes(32).toString('hex'))"`.

- [ ] **Step 4: Write `.github/workflows/deploy.yml`**

```yaml
name: Deploy

on:
  push:
    branches: [main]
  workflow_dispatch:
    inputs:
      target:
        description: Where to deploy the API
        type: choice
        options: [staging, production]
        default: staging

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: deploy
  cancel-in-progress: false

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: node --test

  deploy-worker:
    needs: test
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm ci
      - uses: cloudflare/wrangler-action@v3
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          command: >-
            deploy --config worker/wrangler.toml
            ${{ github.event_name == 'workflow_dispatch' && inputs.target == 'staging' && '--env staging' || '' }}
            --var COMMIT_SHA:${{ github.sha }}

  deploy-pages:
    needs: deploy-worker
    if: github.event_name == 'push' || inputs.target == 'production'
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deploy.outputs.page_url }}
    steps:
      - uses: actions/checkout@v4
      - name: Write public site config
        run: |
          cat > assets/js/config.js <<EOF
          export const PAYPAL_CLIENT_ID = '${{ vars.PAYPAL_CLIENT_ID }}';
          export const API_BASE = '${{ vars.API_BASE }}';
          EOF
      - name: Assemble site
        run: |
          mkdir -p _site
          cp -r assets pages data _site/
          cp *.html _site/
      - uses: actions/upload-pages-artifact@v3
        with:
          path: _site
      - id: deploy
        uses: actions/deploy-pages@v4
```

- [ ] **Step 5 (human): Repository settings**

- Settings → Secrets and variables → Actions → **Secrets**: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`.
- **Variables**: `PAYPAL_CLIENT_ID` (sandbox until launch); `API_BASE` (`https://api.evincus.shop`, or the production `workers.dev` URL).
- Settings → Pages → Source: **GitHub Actions**.

- [ ] **Step 6: Commit, then run staging**

```bash
git add .github/workflows/deploy.yml worker/wrangler.toml
git commit -m "Deploy Worker and GitHub Pages from CI"
```

The human pushes the branch and runs the workflow manually with target `staging`. Then:
- `curl -s https://evincus-api-staging.<account>.workers.dev/api/health` returns `ok: true` and `commit` equal to the pushed SHA.
- Point a local `config.js` `API_BASE` at the staging URL, serve the site locally with the staging origin allowed (temporarily add `http://localhost:5180` to staging `ALLOWED_ORIGINS`, or test from the Pages URL after production), and complete one sandbox purchase. The receipt and owner emails arrive, `npx wrangler tail --env staging --config worker/wrangler.toml` shows `order.captured`, and `npx wrangler kv key list --binding ORDERS --env staging --config worker/wrangler.toml --remote` lists `order:` and `day:` keys.

- [ ] **Step 7: Production**

Once staging passes, merge or push to `main`. CI runs test → deploy-worker → deploy-pages. Check:
- `/api/health` on production shows the new commit.
- The Pages site loads the catalog from the API (devtools network tab), and the bag quote works.
- `PAYPAL_ENV` stays `sandbox` until the human decides to go live. Going live means setting `PAYPAL_ENV = "live"`, the live client ID in `wrangler.toml` and the `PAYPAL_CLIENT_ID` repo variable, and the live `PAYPAL_CLIENT_SECRET` via `wrangler secret put`.

---

### Task 14: Remove Netlify, update README, uptime monitor

**Files:**
- Delete: `netlify/`, `netlify.toml`, `data/products.js`, `tests/orders.test.mjs`
- Modify: `README.md`, `.gitignore`

**Interfaces:**
- Consumes: everything above. Nothing new is produced.

- [ ] **Step 1: Confirm nothing still imports the old files**

Run: `grep -rn "products.js\|netlify" --include=*.js --include=*.mjs --include=*.html --include=*.toml --include=*.yml . | grep -v node_modules | grep -v docs/`
Expected: only `tests/orders.test.mjs` and `netlify/` itself.

- [ ] **Step 2: Delete**

```bash
git rm -r netlify netlify.toml data/products.js tests/orders.test.mjs
```
Remove the `.netlify/` line from `.gitignore`.

Run: `node --test`
Expected: PASS (catalog, data, routes-catalog, quote, alerts, orders-create, orders-capture, emails, beacon).

- [ ] **Step 3: Rewrite `README.md`**

````markdown
# Evincus storefront

Static store on GitHub Pages plus an API on a Cloudflare Worker. No build step: vanilla ES modules, hash routing,
PayPal JS SDK checkout. Design spec: `docs/superpowers/specs/2026-10-03-backend-bag-eras-design.md`.

## Layout

- `index.html`, `index.store.html`, `pages/`, `assets/`: the site.
- `data/eras.json`, `data/products.json`, `data/site.json`: the catalog. Edit these to add drops, change prices or mark things sold out.
- `data/catalog.js`: catalog rules shared by the site and the API (era status, what's visible, what's buyable).
- `worker/`: the API (`wrangler.toml`, `src/index.js` router, `src/routes`, `src/lib`, `src/emails`).

## Run locally

```bash
npm install
cp assets/js/config.example.js assets/js/config.js   # API_BASE = 'http://localhost:8787'
npm run dev:api                                        # API on http://localhost:8787
npx http-server -p 5180 -c-1 .                         # site on http://localhost:5180/index.store.html
```

`.dev.vars` (gitignored) holds local secrets and `ENVIRONMENT=development` (which lets localhost through CORS):

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

## Payments

The browser sends only product id, colour, size and quantity. The Worker prices the bag from the catalog, creates
the PayPal order with a server-signed tag, and at capture re-checks the tag, re-prices every line, checks every line
is still buyable, then verifies the captured amount. Each order is saved to KV for 2 years; the customer gets a
receipt and the owner a notification through Resend, with retries every 15 minutes if sending fails.

## Monitoring

- **Logs:** Cloudflare dashboard → Workers → evincus-api → Logs. Every line is JSON with `event`, `reqId` and `route`.
  Errors shown to shoppers include the request id. Live view: `npx wrangler tail --config worker/wrangler.toml`.
- **Alerts:** emailed to `OWNER_EMAIL` for unsaved paid orders, possible tampering, undelivered receipts,
  PayPal outages (5+ errors in 10 minutes) and unhandled errors. At most one per event type per hour.
- **Uptime (set up once by hand):** create a free UptimeRobot or Better Stack monitor for
  `https://api.evincus.shop/api/health` (expects HTTP 200 and `"ok":true`) and one for the Pages homepage, both every
  5 minutes, alerting by email or SMS. This catches the Worker being down, which it can't report itself.
- **Free tier:** KV allows 1,000 writes/day (each order uses about 3). Move to Workers Paid ($5/month) above about
  300 orders/day or for 7-day log retention.
````

- [ ] **Step 4 (human): Create the uptime monitors**

Create the two monitors described in the README and confirm both show "up".

- [ ] **Step 5: Commit**

```bash
git add README.md .gitignore
git commit -m "Remove Netlify functions and document the Worker setup"
```

---

## Amendment (2026-10-03): landing page is the only site page

The user chose `index.html` (the "⚠ WARNING · Catastrophe — 2026" design) as the only page. Tasks 11 and 12 above are superseded:

- **Task 11 (amended):** bag drawer, product view dialog and in-drawer PayPal checkout built into `index.html` (`assets/js/bag.js`, `product-view.js`, `quote.js`, reworked `paypal.js`, styles in `assets/css/index.css`).
- **Task 12 (amended):** era filter, era intro, upcoming teaser and sold-out/ended tags in the `#shop` section; the old store app (`index.store.html`, `evincus-redesign.html`, `assets/js/app.js`, `ui.js`, `totals.js`, `redesign.js`, `pages/`, `assets/css/main.css`, `redesign.css`) is deleted.
- Task 10 is unchanged, but its browser check runs on `index.html`.
- Task 14's README describes `index.html` as the site.
