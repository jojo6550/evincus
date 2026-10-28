# Inventory System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move eras, products, photos and stock onto the Render disk and give the owner a private Shopify-style
`/inventory` app (Inventory, Orders, Stats, Logs; Finances arrives with WiPay) with owner/viewer accounts created
from the CLI.

**Architecture:** The catalog moves from `data/eras/*.js` into the existing KV (`era:`, `product:`, `stock:` keys,
plus a `catalog:rev` cache key) and photos into content-named files under `MEDIA_PATH`. Every write is one
version-checked `env.ORDERS.commit` carrying an `op:<opId>` idempotency record. A new session-authenticated
`/api/inventory/*` API serves a vanilla-JS page at `/inventory`; token-authenticated `/api/admin/*` endpoints serve
the CLI.

**Tech Stack:** Node 22, vanilla ES modules (no build), `@deno/kv` on SQLite, WebCrypto, `node --test`, `sharp`
(dev dependency, CLI only).

**Spec:** `docs/superpowers/specs/2026-10-27-inventory-design.md`

## Global Constraints

- No new runtime dependency. `sharp` stays in `devDependencies` and is imported only by `scripts/`.
- CSS only in `assets/css/`, JS only in `assets/js/`. No `style=` attributes, no inline `<style>` or `<script>`. Colour swatches are inline SVG `fill` attributes, as in `assets/js/product-view.js`.
- Mobile first: base CSS for ~375px, `min-width` queries only; at ≥ 768px the tab bar becomes a left sidebar.
- `server/` uses only web-standard `Request`/`Response`; routes go in the `ROUTES` table in `server/index.js`.
- Money is integer cents. Days are Jamaica days (UTC-5, no DST), as `dayKey` in `server/lib/orders.js`.
- Every state-changing inventory request carries `opId` (a `crypto.randomUUID()`), and every write is one `env.ORDERS.commit` with version checks. Nothing reads then writes without a check.
- Store look: `--ink` background, `--bone` text, `--ash` / `--char` cards, `--hazard` accent (from `assets/css/index.css`).
- Logs never carry customer PII (`PII_KEYS` in `server/lib/log.js`); staff identity goes in an `account` field.
- Viewers never receive customer name, email, phone, customer notes, internal notes, `costCents`, margin or profit from any endpoint. The API leaves those fields out; the page doesn't merely hide them.
- Order value is never called "Revenue". Stats says "Sales (order value)". "Revenue" belongs to Finances, which ships with WiPay and is not part of this plan. The product page's per-item margin is labelled "before GCT and fees".
- Every task ends with `node --test` passing in full.

## Review Focus

- A draft or archived product, or one in a draft or archived era, must not appear through **any** public path: `/api/catalog`, `/api/eras/:slug`, `/api/products/:id`, `/products/<id>`, `sitemap.xml`, newsletter emails, or `/api/bag/quote`, where it reads as `unknown-item`. Test owner: Task 4.
- A shopper's saved cart holding a colour that was later renamed or removed shows "No longer available" and blocks checkout without errors. Test owner: Task 5.
- A colour or size name containing `|`, an empty name, or one over 100 characters (the limit `parseItems` accepts) must be refused at save. Otherwise cart lines for it can never be bought. Test owner: Task 11.
- KV `list` returns at most 1000 keys per page. Stock, products, orders and logs past 1000 keys must all load by following `cursor`. Test owners: Tasks 3 and 19.
- An owner whose session ends mid-edit (password reissued with `add-viewer`) gets the sign-in screen on the next request, and their unsaved product edits are kept in the page so they can save again after signing in. Test owner: Task 13.

---

## File map

| File | Responsibility |
|---|---|
| `data/photos.js` (new) | Photo variant rules shared by browser, server and CLI. |
| `data/catalog.js` | Pure catalog rules; gains stock, product `status`, era `state`. |
| `server/lib/media.js` (new) | Media name rules, image header sniffing, file store, photo storage. |
| `server/lib/stock.js` (new) | Stock keys, loading, adjustments, checkout commit plan, movements. |
| `server/lib/ops.js` (new) | `op:<opId>` idempotency records. |
| `server/lib/catalog-store.js` (new) | Catalog read cache, seeding, product/era/order saves, validation. |
| `server/lib/accounts.js` (new) | Password hashing, accounts, sessions, `requireStaff`. |
| `server/lib/order-flow.js` (new) | Pure order transitions, stock movements, refunds, day-index summary. |
| `server/lib/retention.js` (new) | TTL rewrite and 2-year personal-data scrub. |
| `server/lib/stats.js` (new) | Stats aggregation. |
| `server/lib/log-store.js` (new) | Saving selected log lines to KV and reading them back. |
| `server/routes/inventory.js` (new) | Session API: auth, products, eras, stock, media, orders, stats, logs, health. |
| `server/routes/admin.js` | Token API: sales (existing), accounts, eras, media, photos, export, import. |
| `scripts/lib/admin-cli.mjs` (new) | Option parsing, base URL, token and fetch shared by every admin CLI. |
| `scripts/viewers.mjs` (new) | `add-viewer`, `remove-viewer`, `list-viewers`. |
| `scripts/inventory-pull.mjs` (new) | One-way prod-to-local copy. |
| `inventory.html`, `assets/css/inventory.css`, `assets/js/inventory*.js` (new) | The page. |

---

## Phase 1: catalog on disk

### Task 1: Shared stock and photo rules

**Files:**
- Create: `data/photos.js`
- Modify: `data/catalog.js`, `server/lib/pricing.js`, `tests/helpers/fixture.mjs`, `tests/helpers/fake-env.mjs`
- Test: `tests/catalog.test.mjs`, `tests/quote.test.mjs`, `tests/photos-rules.test.mjs`

**Interfaces:**
- Produces (`data/photos.js`): `WIDTHS = [480, 960, 1440]`, `MAX_VARIANT_BYTES = 250 * 1024`, `variantWidths(width: number): number[]` (each of `WIDTHS` ≤ `width`, plus `width` itself when it is under 1440, ascending, deduplicated), `photoPath(ref, w = ref.widths.at(-1)): string` → `` `media/${ref.id}-${w}.${ref.ext}` ``, `manifestEntry(ref)` → `{ width, height, variants: [{ src, width }] }` (the `image-manifest.js` entry shape).
- Produces (`data/catalog.js`): `applyStock(data, stock: Map<string, { onHand: number, committed: number }>) → data` (each product gains `available: { '<colour>|<size>': number }`, where a missing key counts as 0 on hand and 0 committed). `isVisible(p, data): boolean` (product `status` is `'active'` or missing, its era exists, and the era's `state` is `'published'` or missing). `publicView(data, now)` is unchanged in signature. It drops invisible products and eras whose `state` is draft or archived, computes `soldOutVariants` from `available`, sets `soldOut` when every variant is sold out, and strips `available`, `costCents` and `skus` from its output. `lineStatus` returns `'unknown-item'` for invisible products. A variant counts as sold out when `available ≤ 0` and `continueSelling` is not true.
- Produces (`server/lib/pricing.js`): `quote(data, now, items)` gives an `ok` line whose `qty` exceeds the variant's `available` (when `continueSelling` is not set) the status `'insufficient-stock'` and an `available` field. `COUNTED` is unchanged, so that line blocks `checkoutReady`.
- Produces (tests): `fixtureStock(data = FIXTURE): Map` in `tests/helpers/fixture.mjs` gives 10 on hand per variant, except 0 for `alpha-hood|Black|M` and `alpha-tee|White|M`. Remove `soldOut` / `soldOutVariants` from `FIXTURE`. `makeEnv()` seeds those stock values into its fake KV as `stock:<key>` entries carrying `{ onHand, committed }` as both value and metadata, so existing route tests keep their meaning. Add `putStock(env, lineKey, onHand, committed)` and `stockOf(env, lineKey) → { onHand, committed }` to `fake-env.mjs` for later tasks.

- [ ] **Step 1: Write the failing tests**

```js
// tests/photos-rules.test.mjs
test('variantWidths keeps standard widths up to the photo and adds its own width under 1440', () => {
  assert.deepEqual(variantWidths(2400), [480, 960, 1440]);
  assert.deepEqual(variantWidths(1200), [480, 960, 1200]);
  assert.deepEqual(variantWidths(720), [480, 720]);
  assert.deepEqual(variantWidths(400), [400]);
});
test('photoPath and manifestEntry use relative media paths', () => {
  const ref = { id: 'a'.repeat(24), width: 1200, height: 1500, widths: [480, 960, 1200], ext: 'webp' };
  assert.equal(photoPath(ref), `media/${'a'.repeat(24)}-1200.webp`);
  assert.deepEqual(manifestEntry(ref).variants.map(v => v.width), [480, 960, 1200]);
});
// tests/catalog.test.mjs
test('stock decides sold out; continueSelling never sells out', () => {
  const data = applyStock(FIXTURE, fixtureStock());
  const v = publicView(data, new Date(NOW));
  assert.deepEqual(v.products.find(p => p.id === 'alpha-tee').soldOutVariants, ['White|M']);
  assert.equal(v.products.find(p => p.id === 'alpha-hood').soldOut, true);
  assert.equal('available' in v.products[0], false);
  const keep = { ...FIXTURE, products: FIXTURE.products.map(p => p.id === 'alpha-hood' ? { ...p, continueSelling: true } : p) };
  assert.equal(publicView(applyStock(keep, fixtureStock()), new Date(NOW)).products.find(p => p.id === 'alpha-hood').soldOut, false);
});
test('draft products, archived products and products of draft eras are invisible everywhere', () => {
  const data = { ...FIXTURE, eras: FIXTURE.eras.map(e => e.slug === 'old' ? { ...e, state: 'draft' } : e),
    products: FIXTURE.products.map(p => p.id === 'alpha-hood' ? { ...p, status: 'draft' } : p) };
  const v = publicView(applyStock(data, fixtureStock()), new Date(NOW));
  assert.equal(v.products.some(p => p.id === 'alpha-hood' || p.id === 'old-tee'), false);
  assert.equal(v.eras.some(e => e.slug === 'old'), false);
  assert.equal(lineStatus(data, new Date(NOW), { id: 'alpha-hood', color: 'Black', size: 'M' }), 'unknown-item');
});
// tests/quote.test.mjs
test('a line above available stock is insufficient-stock with the count, and blocks checkout', () => {
  const stock = fixtureStock(); stock.set('alpha-tee|Black, white print|S', { onHand: 3, committed: 1 });
  const q = quote(applyStock(FIXTURE, stock), new Date(NOW), [{ id: 'alpha-tee', color: 'Black, white print', size: 'S', qty: 3 }]);
  assert.equal(q.lines[0].status, 'insufficient-stock');
  assert.equal(q.lines[0].available, 2);
  assert.equal(q.checkoutReady, false);
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `node --test tests/photos-rules.test.mjs tests/catalog.test.mjs tests/quote.test.mjs`
Expected: FAIL (`variantWidths` / `applyStock` not exported).

- [ ] **Step 3: Implement `data/photos.js`, the `data/catalog.js` changes, the `quote` change and the fixture helpers**

`isSoldOut(p, color, size)` becomes `(p.available?.[`${color}|${size}`] ?? 0) <= 0 && p.continueSelling !== true`. Callers outside the server (`assets/js/*`) never call `applyStock`; they only read `publicView` output from the API.

- [ ] **Step 4: Run the full suite**

Run: `node --test`
Expected: PASS. Fix existing tests that asserted the removed fixture flags so they assert the computed fields instead.

- [ ] **Step 5: Commit**

```bash
git add data/photos.js data/catalog.js server/lib/pricing.js tests/
git commit -m "feat(catalog): derive sold out from stock; product status and era state"
```

### Task 2: Media store

**Files:**
- Create: `server/lib/media.js`
- Modify: `tests/helpers/fake-env.mjs` (add `fakeMedia()`, put it on `makeEnv()` as `MEDIA`)
- Test: `tests/media.test.mjs`

**Interfaces:**
- Consumes: `variantWidths`, `MAX_VARIANT_BYTES` from Task 1.
- Produces:
  - `MEDIA_NAME = /^[0-9a-f]{24}-[0-9]{3,4}\.(webp|jpg)$/`.
  - `sniffImage(bytes: Uint8Array) → { ext: 'webp' | 'jpg', width, height } | null`. Read WebP `VP8 ` / `VP8L` / `VP8X` headers and JPEG SOF0–SOF15 markers, except DHT/JPG/DAC.
  - `mediaStore(dir: string) → { read(name): Promise<Uint8Array | null>, write(name, bytes): Promise<void>, has(name): Promise<boolean>, list(): Promise<{ name, mtimeMs }[]>, remove(name): Promise<void> }`. `write` goes to a temp file then `rename`s, and does nothing if the name exists. Every method throws on a name failing `MEDIA_NAME`.
  - `storePhoto(media, files: Uint8Array[]) → Promise<photoRef>`, where `photoRef = { id, width, height, widths, ext }` and `id` = first 24 hex of sha256 of the widest file. It throws `HttpError('invalid-photo', 400)` unless:
    - every file sniffs as the same type;
    - each file is ≤ `MAX_VARIANT_BYTES`;
    - none is wider than 1440;
    - the set of widths equals `variantWidths(widest)`;
    - all aspect ratios agree with the widest file's to within 1%.
  - `fakeMedia()`: the same surface over a `Map`.

- [ ] **Step 1: Write the failing tests**

Fixtures: make small real images in-test with `sharp` (dev dependency, test-only use is fine), e.g. `sharp({ create: { width: 1200, height: 1500, channels: 3, background: '#222' } }).webp().toBuffer()`.

```js
test('sniffImage reads WebP and JPEG sizes and rejects other bytes', async () => { /* 1200×1500 webp, 960×1200 jpg, PNG → null, 'GIF89a' → null */ });
test('storePhoto stores a full variant set under content names and is idempotent', async () => {
  const media = fakeMedia();
  const ref = await storePhoto(media, await variants(1200, 1500, 'webp'));
  assert.deepEqual(ref.widths, [480, 960, 1200]);
  assert.match(`${ref.id}-1200.webp`, MEDIA_NAME);
  assert.deepEqual(await storePhoto(media, await variants(1200, 1500, 'webp')), ref);
  assert.equal((await media.list()).length, 3);
});
test('storePhoto refuses mixed types, a missing width, an oversized file, a 1600px file and a wrong aspect ratio', async () => { /* each → code 'invalid-photo' */ });
test('mediaStore refuses names outside MEDIA_NAME, including traversal', async () => { /* '../x', 'a.webp', `${'a'.repeat(24)}-1200.png` */ });
```

- [ ] **Step 2: Run them and see them fail**

Run: `node --test tests/media.test.mjs`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement `server/lib/media.js` and `fakeMedia()`**

- [ ] **Step 4: Run the full suite**

Run: `node --test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/lib/media.js tests/media.test.mjs tests/helpers/fake-env.mjs
git commit -m "feat(media): content-named responsive photo store"
```

### Task 3: Catalog store, stock loading and seeding

**Files:**
- Create: `server/lib/catalog-store.js`, `server/lib/stock.js`
- Test: `tests/catalog-store.test.mjs`

**Interfaces:**
- Consumes: `storePhoto`, `mediaStore` (Task 2); `photoPath`, `manifestEntry` (Task 1); `merge`-era modules from `data/eras/index.js`; `assets/js/image-manifest.js`.
- Produces (`server/lib/stock.js`):
  - `stockKey(lineKey) → 'stock:' + lineKey`.
  - `loadStock(env) → Map<lineKey, { onHand, committed }>`: one paged `list({ prefix: 'stock:' })`, read from metadata, following `cursor` until `list_complete`.
  - `stockEntry(onHand, committed)` → `{ value, opts: { metadata: { onHand, committed } } }`, for use inside commits.
- Produces (`server/lib/catalog-store.js`):
  - Keys: `REV_KEY = 'catalog:rev'`, `eraKey(slug)`, `productKey(id)`.
  - `loadCatalog(env) → { eras, products, media, rev }`. It reads `REV_KEY` on every call and reloads all `era:` / `product:` keys (paged) only when `rev` differs from the in-memory copy.
    - Era and product photo refs become `photoPath(ref)` strings.
    - `media` is `{ [photoPath(ref)]: manifestEntry(ref) }` for every ref.
    - `eras` follow `eraOrder`.
    - Internal fields (`costCents`, `skus`, `status`, `continueSelling`, `lowStockAt`, `state`) stay on the objects; `publicView` strips them.
  - `seedCatalog(env, { modules, manifest, root, seedStock }) → Promise<boolean>`: does nothing and returns false when `REV_KEY` exists. Otherwise:
    - stores each image's existing variants (files under `assets/img/responsive/`, listed by the manifest entry for `data/eras/<slug>/img/<file>`) with `storePhoto`;
    - commits every `era:` (`state: 'published'`), `product:` (`status: 'active'`, `costCents: 0`, `continueSelling: false`, `lowStockAt: 3`, default SKUs from `defaultSku`), `stock:` (`seedStock` on hand, 0 committed) and `REV_KEY` (`{ rev, eraOrder }`) in one commit, guarded by a check that `REV_KEY` is absent;
    - returns true.
    `soldOut` / `soldOutVariants` from the seed files are dropped. The seed's own value of 0 on hand covers them.
  - `defaultSku(productId, color, size, taken: Set<string>) → string`: `<ID>-<CODE>-<SIZE>` upper-case. `CODE` is the colour's last word with its vowels removed after the first letter, first 3 letters, so `Classic Black` gives `BLK` and `Lucent White` gives `WHT`. If the SKU is in `taken`, append `-2`, `-3` and so on.

- [ ] **Step 1: Write the failing tests**

```js
test('seedCatalog imports the era files once, with photos, published eras, active products and seeded stock', async () => {
  const env = makeEnv({ ORDERS: fakeKV(), MEDIA: fakeMedia() });
  assert.equal(await seedCatalog(env, { modules: ERAS_FOR_TEST, manifest, root, seedStock: 10 }), true);
  assert.equal(await seedCatalog(env, { modules: ERAS_FOR_TEST, manifest, root, seedStock: 10 }), false);
  const cat = await loadCatalog(env);
  assert.equal(cat.products.find(p => p.id === '99-tee').status, 'active');
  assert.match(cat.products.find(p => p.id === '99-tee').colors[0].images[0], /^media\/[0-9a-f]{24}-\d+\.webp$/);
  assert.ok(cat.media[cat.products[0].colors[0].images[0]].variants.length >= 2);
  assert.equal((await loadStock(env)).get('99-tee|Classic Black|M').onHand, 10);
});
test('loadCatalog reloads only when catalog:rev changes', async () => { /* count ORDERS.list calls via a wrapper: 2 loads same rev → 1 list round; bump rev → reload */ });
test('loadStock and loadCatalog follow list cursors past 1000 keys', async () => { /* fake KV wrapper whose list pages at 2 keys; 5 stock keys all load */ });
test('defaultSku follows the colour-code rule and avoids clashes', () => {
  assert.equal(defaultSku('99-tee', 'Classic Black', 'M', new Set()), '99-TEE-BLK-M');
  assert.equal(defaultSku('99-tee', 'Lucent White', '2XL', new Set()), '99-TEE-WHT-2XL');
  assert.equal(defaultSku('99-tee', 'Classic Black', 'M', new Set(['99-TEE-BLK-M'])), '99-TEE-BLK-M-2');
});
```

`ERAS_FOR_TEST` is the real `data/eras` modules (import `* as` from each `era.js`), so seeding is checked against real data. Give the fake KV's `list` optional paging (`pageSize`) in `fake-env.mjs`, and make `fakeKV().list` honour `cursor`.

- [ ] **Step 2: Run them and see them fail**

Run: `node --test tests/catalog-store.test.mjs`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement `server/lib/stock.js` (the three exports above) and `server/lib/catalog-store.js` (keys, `loadCatalog`, `seedCatalog`, `defaultSku`)**

`data/eras/index.js` should also export `ERAS` (the module list), so the seed reuses its order (newest first).

- [ ] **Step 4: Run the full suite**

Run: `node --test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/lib/catalog-store.js server/lib/stock.js data/eras/index.js tests/
git commit -m "feat(catalog): KV catalog store with rev cache and one-time seed"
```

### Task 4: Serve the store from KV

**Files:**
- Modify: `server/index.js`, `server/static.js`, `server/routes/eras.js`, `server/routes/products.js`, `server/routes/health.js`, `server/lib/catalog.js`, `server/lib/security.js`, `main.js`, `render.yaml`, `.env.example`, `scripts/lib/local-server.mjs`, `assets/js/images.js`, `assets/js/store.js`, `tests/store-lazy.test.mjs`
- Test: `tests/routes-catalog.test.mjs`, `tests/static.test.mjs`

**Interfaces:**
- Consumes: `loadCatalog`, `seedCatalog` (Task 3); `loadStock` (Task 3); `applyStock`, `publicView` (Task 1); `MEDIA_NAME` (Task 2).
- Produces:
  - `createApp({ data, clock })`. When `data` is given (tests), it is used as the catalog. Otherwise each request sets `c.data = await loadCatalog(env)` with `site` from `data/site.json` merged in. Price-reading routes (`hit[3]`) then apply sales and `applyStock(c.data, await loadStock(env))`.
  - `scheduled` (newsletter and digest) loads the catalog the same way when no `data` was injected.
  - `serveStatic(req, { env, readFile, statFile, data })`: without `data`, it loads the catalog the same way and applies stock, so product pages say `OutOfStock` in JSON-LD exactly when the API says sold out. It serves `/media/<name>` from `env.MEDIA` (names matching `MEDIA_NAME` only, `Cache-Control: public, max-age=31536000, immutable`, type from the extension).
  - `/api/catalog`, `/api/eras/:slug` and `/api/products/:id` responses add `media: { [path]: manifestEntry }` covering exactly the image paths in that response.
  - `assets/js/images.js` exports `registerImages(map)`, which merges `map` into the manifest lookup. `safeImage` also accepts `media/<MEDIA_NAME>` paths.
  - `assets/js/store.js` calls `registerImages(media)` after `/api/catalog`. `fromStatic` is deleted, and so is the static import of `data/eras/index.js`.
  - `main.js`: `env.MEDIA = mediaStore(process.env.MEDIA_PATH ?? '.media')`. Before `listen`, it awaits `seedCatalog(env, { modules: ERAS, manifest, root, seedStock: Number(process.env.SEED_STOCK ?? 0) })`.
  - `render.yaml`: prod `MEDIA_PATH=/var/data/media`. Dev `MEDIA_PATH=/tmp/media` and `SEED_STOCK=10`.
  - `scripts/lib/local-server.mjs`: `MEDIA_PATH` in its temp dir, and `SEED_STOCK=10`, so `check:load` still finds buyable stock.
  - CSP `img-src 'self' data: blob:`.

- [ ] **Step 1: Write the failing tests**

```js
// tests/routes-catalog.test.mjs
test('without injected data the API serves the KV catalog with stock applied and a media map', async () => {
  const env = makeEnv(); await seedFromFixture(env);   // helper: puts FIXTURE as era:/product:/catalog:rev with photo refs
  const r = await callWithoutData('GET', '/api/catalog', { env });
  assert.equal(r.status, 200);
  const img = r.json.products[0].colors[0].images[0];
  assert.match(img, /^media\//);
  assert.ok(r.json.media[img].variants.length);
  assert.equal(r.json.products.some(p => 'costCents' in p || 'available' in p || 'skus' in p), false);
});
test('a draft product is absent from catalog, era, product, quote, product page and sitemap', async () => { /* Review Focus 1 */ });
// tests/static.test.mjs
test('/media serves only content-named files, immutable, and 404s anything else', async () => { /* good name → 200 image/webp immutable; 'x.webp', '../kv.sqlite3' → 404 */ });
test('/media and /inventory stay up when STATUS closes the public domain', async () => { /* STATUS=stocking, host evincus.shop → /media 200 (inventory page added in Task 9) */ });
```

Add `callWithoutData` to `fake-env.mjs`: it does what `call` does without passing `data`. The static helper in `tests/static.test.mjs` gets the same.

- [ ] **Step 2: Run them and see them fail**

Run: `node --test tests/routes-catalog.test.mjs tests/static.test.mjs`
Expected: FAIL.

- [ ] **Step 3: Implement the wiring listed in Interfaces**

The status gate in `server/static.js` lets `/media/` through as it already does `/assets/`. Newsletter emails and the sitemap read catalog image paths, which now start with `media/`. Both prefix `SITE` + `/`, so they need no change. Confirm that with the existing newsletter tests.

- [ ] **Step 4: Run the full suite plus the CI checks that start the server**

Run: `node --test; npm run check:load; npm run check:restore`
Expected: all PASS. `check:load` reports `uniqueOrders: 1`.

- [ ] **Step 5: Commit**

```bash
git add -A server main.js render.yaml .env.example scripts/lib assets/js tests
git commit -m "feat(catalog)!: storefront reads eras, products, photos and stock from KV"
```

### Task 5: Checkout commits stock

**Files:**
- Modify: `server/lib/submissions.js`, `server/lib/checkout.js`, `server/routes/checkout.js`, `server/lib/stock.js`, `server/lib/http.js`, `assets/js/bag.js`
- Test: `tests/checkout.test.mjs`, `tests/submissions.test.mjs`

**Interfaces:**
- Consumes: `stockKey`, `stockEntry` (Task 3); `quote` with `insufficient-stock` (Task 1).
- Produces:
  - `adjKey(productId, iso, opId, i) → 'adj:<productId>:<iso>:<opId>:<i>'`.
  - `checkoutStock(entries: Map<lineKey, { value, version }>, lines, products, { orderId, now }) → { checks, puts } | { short: [{ key, available }] }`. Pure. For each line it adds Committed + qty, skips the Available check when `continueSelling`, and emits one `adj:` put per line with `reason: 'order'`.
  - `submitOrder(env, id, fingerprint, record, { products } = {})`: when `record` is new, it reads each line's `stock:` entry with `getEntry`. It adds `checkoutStock`'s checks and puts to the existing commit, and retries the whole round on a failed commit (existing `ROUNDS`). If any round finds `short`, it returns `{ short }`.
  - `placeOrderRoute` maps `{ short }` to `fail(c, 'bag-changed', 409, { lines })`, with those lines carrying `status: 'insufficient-stock'` (or `'sold-out'` when `available ≤ 0`) and `available`.
  - `directRecord` gains `stockCommitted: true`, plus `sku` and `costCents` on every line, read from the internal product.
  - `bag.js` `STATUS_TEXT['insufficient-stock']` is `` `Only ${l.available} left` ``, built in `lineHtml`.

- [ ] **Step 1: Write the failing tests**

```js
test('two checkouts racing for the last unit: one order, one bag-changed, stock committed once', async () => {
  const env = makeEnv(); await putStock(env, 'alpha-tee|Black, white print|S', 1, 0);
  const [a, b] = await Promise.all([place(oneUnit(), env), place(oneUnit(), env)]);
  assert.deepEqual([a.status, b.status].sort(), [201, 409]);
  assert.equal(stockOf(env, 'alpha-tee|Black, white print|S').committed, 1);
});
test('a retried checkout returns the same order and commits stock once', async () => { /* same body twice → 201 both, committed === qty, one adj: key */ });
test('continueSelling oversells instead of refusing', async () => { /* onHand 0, continueSelling → 201, committed 1 */ });
test('a cart line for a renamed or removed colour is unknown-item and blocks checkout', async () => { /* Review Focus 2: quote and order both refuse, no 500 */ });
test('orders store sku, costCents and stockCommitted', async () => { /* record.lines[0].sku === 'ALPHA-TEE-PRN-S' etc., stockCommitted true */ });
```

To make the race real, the fake KV `commit` must interleave correctly. It already checks versions synchronously. Run the two `place` calls through `Promise.all` without awaiting between them.

- [ ] **Step 2: Run them and see them fail**

Run: `node --test tests/checkout.test.mjs tests/submissions.test.mjs`
Expected: FAIL.

- [ ] **Step 3: Implement `checkoutStock`, the `submitOrder` / `placeOrderRoute` / `directRecord` changes and the bag text**

Before writing the commit step, confirm the `@deno/kv` per-commit limits with a real-KV test in `tests/kv-store.test.mjs`. A 50-line cart (about 105 checks) must commit. If it can't, lower `MAX_LINES` in `server/lib/pricing.js` to the largest value that does, and pin that value in the test.

- [ ] **Step 4: Run the full suite and the load check**

Run: `node --test; npm run check:load`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server tests assets/js/bag.js
git commit -m "feat(checkout): commit stock atomically with the order"
```

---

## Phase 2: accounts and the shell

### Task 6: Accounts and sessions

**Files:**
- Create: `server/lib/accounts.js`
- Test: `tests/accounts.test.mjs`

**Interfaces:**
- Produces:
  - `ROLES = ['owner', 'viewer']`, `ITERATIONS = 600000`, `SESSION_TTL = 604800`, `COOKIE = 'evincus_inv'`.
  - `accountKey(email) → 'account:' + email.trim().toLowerCase()`.
  - `hashPassword(password, saltB64, iterations = ITERATIONS) → Promise<string>`: PBKDF2-SHA256 via `crypto.subtle`, 32-byte output, base64. The CLI uses the same function.
  - `verifyLogin(env, email, password) → Promise<account | null>`: always runs one PBKDF2. When the account is missing, it hashes against a fixed dummy salt and returns null.
  - `startSession(env, account, now) → Promise<string>`: 32 random bytes as hex. Stores `session:<sha256 hex of token>` = `{ email, epoch, expiresAt }` with `expirationTtl: SESSION_TTL`.
  - `sessionCookie(token, secure) → string`: `evincus_inv=<token>; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800`, plus `; Secure` when `secure`. `clearCookie(secure)` sets `Max-Age=0`.
  - `staffFrom(req, env) → Promise<{ email, role, sessionKey } | null>`: reads the cookie, loads the session and then the account. Returns null if either is missing or the `epoch` differs.
  - `requireStaff(req, c, { role = 'viewer', write = false } = {}) → Promise<{ email, role }>`. It throws `HttpError` as follows:
    - `'signed-out'` 401: no staff session.
    - `'forbidden'` 403: `role === 'owner'` is required and the staff role is `viewer`.
    - `'bad-origin'` 403: `write` and the `Origin` header isn't the request URL's origin.

- [ ] **Step 1: Write the failing tests**

```js
test('hashPassword is PBKDF2-SHA256 with 600000 iterations', async () => { /* compare with a crypto.subtle deriveBits computed in-test */ });
test('verifyLogin accepts the right password, refuses a wrong one and an unknown email the same way', async () => { /* both null; timing not asserted */ });
test('a session survives until epoch changes, then staffFrom returns null', async () => { /* bump account.epoch → null */ });
test('requireStaff: viewer cannot write owner routes; a write needs a same-origin Origin', async () => { /* forbidden; bad-origin for missing and foreign Origin */ });
test('sessionCookie adds Secure only over HTTPS', () => { /* exact strings */ });
```

- [ ] **Step 2: Run them and see them fail**

Run: `node --test tests/accounts.test.mjs`
Expected: FAIL.

- [ ] **Step 3: Implement `server/lib/accounts.js`**

- [ ] **Step 4: Run the full suite**

Run: `node --test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/lib/accounts.js tests/accounts.test.mjs
git commit -m "feat(auth): PBKDF2 accounts and epoch-checked sessions"
```

### Task 7: Auth routes, account endpoints and status-gate exemptions

**Files:**
- Create: `server/routes/inventory.js`
- Modify: `server/routes/admin.js`, `server/index.js`, `server/lib/http.js`, `main.js`, `tests/helpers/fake-env.mjs`
- Test: `tests/inventory-auth.test.mjs`, `tests/admin.test.mjs`

**Interfaces:**
- Consumes: Task 6.
- Produces:
  - Session routes: `POST /api/inventory/login { email, password }` → `{ email, role }` + `Set-Cookie`, or `401 login-failed`. `POST /api/inventory/logout` → 204 + cleared cookie. `GET /api/inventory/me` → `{ email, role, local }`, where `local = env.ENVIRONMENT === 'development'`.
  - Token routes (existing `denied()` check):
    - `PUT /api/admin/accounts { email, role?, salt, hash, iterations }` creates or replaces. On replace it bumps `epoch` and keeps the role unless `role` is given. A new account defaults to `viewer`.
    - `GET /api/admin/accounts` → `{ accounts: [{ email, role, createdAt, lastLoginAt }] }`.
    - `DELETE /api/admin/accounts/<urlencoded email>` → 204 or `404 not-found`.
  - Limiters on `env`:
    - `LOGIN_IP_LIMIT = kvLimiter(kv, 'login-ip', { limit: 10, period: 900 })`;
    - `LOGIN_EMAIL_LIMIT = kvLimiter(kv, 'login-email', { limit: 5, period: 900 })`;
    - `INVENTORY_LIMIT = kvLimiter(kv, 'inventory', { limit: 120, period: 60 })`, applied to every `/api/inventory/*` route.
    `makeEnv()` sets fakes for all three.
  - Status gate: `/api/inventory/*` and `/api/admin/*` skip the `STATUS` 503.
  - New `MESSAGES`: `login-failed` ("That email and password don't match an account."), `signed-out`, `forbidden`, `bad-origin`.
  - Log events `login.ok`, `login.failed`, `login.blocked` with `account` set only when the typed email has an account. `account.added` and `account.removed` likewise.

- [ ] **Step 1: Write the failing tests**

```js
test('login sets an HttpOnly SameSite=Strict cookie and me returns the role', async () => { /* seed account via PUT /api/admin/accounts with hashPassword('correct horse 1') */ });
test('wrong password and unknown email give the same 401 body', async () => { /* deepEqual error.code/message */ });
test('the 6th attempt for one email and the 11th from one IP are 429 and logged login.blocked', async () => {});
test('re-adding an account bumps epoch and signs its sessions out, keeping the role', async () => {});
test('login logs never contain a typed email that has no account', async () => { /* captureLogs; no 'account' field, no address string */ });
test('inventory and admin APIs answer while STATUS=stocking on evincus.shop', async () => {});
```

- [ ] **Step 2: Run them and see them fail**

Run: `node --test tests/inventory-auth.test.mjs tests/admin.test.mjs`
Expected: FAIL.

- [ ] **Step 3: Implement the routes, limiters, messages and gate change**

- [ ] **Step 4: Run the full suite**

Run: `node --test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server main.js tests
git commit -m "feat(auth): inventory login, logout, me and token account endpoints"
```

### Task 8: Admin CLI helpers and the viewer commands

**Files:**
- Create: `scripts/lib/admin-cli.mjs`, `scripts/viewers.mjs`
- Modify: `scripts/discount.mjs` (import the shared helpers; keep re-exporting `PROD_URL`, `LOCAL_URL`, `apiBase`, `adminToken`, `readSales`, `writeSales`), `package.json`
- Test: `tests/viewers.test.mjs`, `tests/discount.test.mjs` (unchanged, must still pass)

**Interfaces:**
- Produces (`scripts/lib/admin-cli.mjs`):
  - `PROD_URL`, `LOCAL_URL`.
  - `parseOptions(argv, { words = {}, values = [] }) → { flags, rest }`: plain-word and `--flag` parsing, moved from `discount.mjs`'s `parseArgs`. `local` and `url=` are always recognised.
  - `apiBase(flags)`; `adminToken(env?, readEnvFile?, name = 'ADMIN_TOKEN')`.
  - `adminFetch(base, token, path, init, fetchFn = fetch) → Response`, which explains an unreachable server as `discount.mjs` does today.
  - `problem(res) → Promise<string>`.
- Produces (`scripts/viewers.mjs`):
  - `generatePassword(random = crypto.getRandomValues) → string`: 20 characters from `123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz`, by rejection sampling.
  - `main(['add', email, ...])`, `main(['remove', email, ...])`, `main(['list', ...])`.
  - `add` hashes with the server's `hashPassword` (imported from `server/lib/accounts.js`) and a fresh 16-byte salt. It prints `Password for <email> (<role>) on <where>: <password>`, then "Shown once. Send it privately."
- `package.json`: `"add-viewer": "node --env-file-if-exists=.env scripts/viewers.mjs add"`, `"remove-viewer": "… remove"`, `"list-viewers": "… list"`.

- [ ] **Step 1: Write the failing tests**

```js
test('generatePassword is 20 characters from the 58-letter alphabet', () => { /* 1000 runs, regex /^[1-9A-HJ-NP-Za-km-z]{20}$/ */ });
test('add sends only salt and hash, never the password, and owner sets the role', async () => { /* fetch stub captures body; no password field; role 'owner' */ });
test('add without a role on an existing account sends no role', async () => {});
test('remove and list hit the account endpoints with the token', async () => {});
```

- [ ] **Step 2: Run them and see them fail**

Run: `node --test tests/viewers.test.mjs`
Expected: FAIL.

- [ ] **Step 3: Implement the helpers, move `discount.mjs` onto them, and write `scripts/viewers.mjs`**

- [ ] **Step 4: Run the full suite**

Run: `node --test`
Expected: PASS, including the unchanged `tests/discount.test.mjs`.

- [ ] **Step 5: Commit**

```bash
git add scripts package.json tests
git commit -m "feat(cli): add-viewer, remove-viewer, list-viewers with generated passwords"
```

### Task 9: The `/inventory` page shell

**Files:**
- Create: `inventory.html`, `assets/css/inventory.css`, `assets/js/inventory.js`, `assets/js/inventory-api.js`
- Modify: `server/static.js`, `server/lib/seo.js` (robots), `README.md`, `docs/superpowers/specs/2026-10-18-admin-dashboard-design.md` (status line: "Replaced by 2026-10-27-inventory-design.md")
- Test: `tests/static.test.mjs`, `tests/inventory-client.test.mjs`

**Interfaces:**
- Consumes: Task 7 routes.
- Produces:
  - `/inventory` → `inventory.html` (`no-cache`), exempt from the status gate. It has `<meta name="robots" content="noindex">`. `robots.txt` adds `Disallow: /inventory`.
  - `inventory-api.js`:
    - `api(method, path, body?, { opId } = {}) → Promise<json>`. It sends JSON and `credentials: 'same-origin'`, adds `opId` into the body for non-GET requests, and throws `ApiError { status, code, message, details }`.
    - A 401 emits `'signed-out'` on `onSignedOut(fn)`.
    - `newOpId() → crypto.randomUUID()`.
  - `inventory.js`:
    - boot calls `GET /api/inventory/me`; on 401 it shows the login form, otherwise the shell;
    - tabs are Inventory, Orders, Stats, Logs. Finances is not in this plan. Logs is shown only to owners;
    - hash routing `#inventory`, `#inventory/<productId>`, `#orders`, `#orders/<id>`, `#stats`, `#logs`;
    - a "LOCAL" badge when `me.local`, and sign-out;
    - `registerTab(name, { render(el, params), canLeave?() })`, which later tasks use to fill tabs;
    - on `signed-out` it re-shows the login form over the current tab without discarding tab state. After login it re-renders the same route.
  - Layout: bottom tab bar on phones. At `@media (min-width: 768px)` the tabs become a left sidebar and lists become tables.
  - README gets an "Inventory" section: roles, the CLI commands, live vs local, the rollout (stock while `STATUS=stocking`; open with WiPay), and the note that `data/eras/` is seed data.

- [ ] **Step 1: Write the failing tests**

```js
// tests/static.test.mjs
test('/inventory serves the noindex shell, also while the store is closed', async () => { /* 200, text/html, includes 'noindex', STATUS=stocking too */ });
test('robots.txt disallows /inventory', async () => {});
// tests/inventory-client.test.mjs (imports assets/js/inventory-api.js with a fetch stub)
test('api adds opId to writes and reports 401 as signed-out', async () => {});
```

- [ ] **Step 2: Run them and see them fail**

Run: `node --test tests/static.test.mjs tests/inventory-client.test.mjs`
Expected: FAIL.

- [ ] **Step 3: Build the page, the static mapping, robots, README and the old-spec status line**

Check the phone layout by hand at 375px with `npm run dev`. Create a local owner with `npm run add-viewer you@example.com owner local`, sign in, and click through the tabs.

- [ ] **Step 4: Run the full suite**

Run: `node --test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add inventory.html assets server README.md docs/superpowers/specs tests
git commit -m "feat(inventory): sign-in screen and tab shell at /inventory"
```

---

## Phase 3: the Inventory tab

### Task 10: Idempotent stock adjustments

**Files:**
- Create: `server/lib/ops.js`
- Modify: `server/lib/stock.js`, `server/routes/inventory.js`, `server/index.js`, `server/lib/http.js`
- Test: `tests/stock.test.mjs`

**Interfaces:**
- Produces (`server/lib/ops.js`): `OP_TTL = 604800`, `isOpId(v)` (UUID v4 regex as in `placeOrderRoute`), `opKey(opId)`, `readOp(env, opId) → Promise<result | null>`, `opPut(opId, result)` → a commit put with `expirationTtl: OP_TTL`.
- Produces (`server/lib/stock.js`):
  - `REASONS = ['received', 'correction', 'damaged', 'returned', 'other']`.
  - `adjustStock(env, { opId, changes: [{ key, delta }], reason, note, by, now }) → Promise<{ stock: { [key]: { onHand, committed } } }>`:
    - validation: ≤ 200 changes, integer non-zero deltas, known keys, `note` ≤ 200 characters;
    - a stored `op:` result is returned as-is;
    - each variant is read with `getEntry`. Deltas go to On hand only. A negative delta that would leave On hand < 0 or < Committed throws `HttpError('stock-below-committed', 409, { key })`;
    - one commit holds the variant checks, the new `stock:` values, one `adj:` per change (`{ key, onHand: delta, committed: 0, reason, note, by, at }`) and `opPut`. A failed commit retries from the read (5 rounds).
- Route: `POST /api/inventory/stock { opId, changes, reason, note }` (owner, write) → `{ stock }`. Logs `stock.adjusted` with `account` and the count of changes.

- [ ] **Step 1: Write the failing tests**

```js
test('two owners adding stock at once both land', async () => { /* Promise.all two +3 on same key → onHand +6, two adj: */ });
test('a retried opId applies once and returns the first result', async () => {});
test('lowering below committed is refused; raising an oversold variant is allowed', async () => {
  /* onHand 1 committed 2: delta -1 → 409 stock-below-committed; delta +5 → onHand 6 */
});
test('viewers get 403 and cross-origin writes get bad-origin', async () => {});
```

- [ ] **Step 2: Run them and see them fail**

Run: `node --test tests/stock.test.mjs`
Expected: FAIL.

- [ ] **Step 3: Implement `ops.js`, `adjustStock` and the route**

- [ ] **Step 4: Run the full suite**

Run: `node --test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server tests
git commit -m "feat(stock): idempotent delta adjustments with history"
```

### Task 11: Product and era reads and saves

**Files:**
- Modify: `server/lib/catalog-store.js`, `server/routes/inventory.js`, `server/routes/admin.js`, `server/index.js`, `server/lib/http.js`
- Test: `tests/catalog-save.test.mjs`

**Interfaces:**
- Consumes: Tasks 3, 6, 10.
- Produces (`server/lib/catalog-store.js`):
  - `validateProduct(product, { eras, products, stock }) → string[]`, which returns error codes. The checks:
    - `id` is a kebab slug and immutable;
    - colour and size names are 1–100 characters with no `|`, and unique within the product;
    - hex matches `/^#[0-9a-f]{6}$/i`;
    - integer `priceCents` > 0 and `costCents` ≥ 0;
    - `status` is in `active | draft | archived`;
    - an `active` product has a name, price, at least one size, one colour and one photo;
    - SKUs are unique across the catalog;
    - removing a colour or size is refused while it has On hand or Committed > 0;
    - renaming a colour is refused while it has Committed > 0.
  - `validateEra(era) → string[]`: a `published` era needs a tagline, story and hero; `dropsAt` / `endsAt` are ISO with an offset, or null.
  - `saveProduct(env, { opId, product, version, by, now }) → { product, version }`:
    - `version` null means create, and refuses an existing id;
    - one commit holds the `product:` check and put, the moved `stock:` keys for a colour rename, the `adj:` records with `reason: 'edit'` and a `summary` (e.g. `Price 32.99 → 34.99`, one per changed field), a new `REV_KEY` and `opPut`;
    - a version mismatch throws `HttpError('product-changed', 409, { current })`.
  - `saveEra(env, { opId, era, version, by, now })`: the same pattern, error `era-changed`. A new era is put first in `eraOrder`.
  - `setEraOrder(env, { opId, order, version })`, checked against `REV_KEY`'s version.
  - `productHistory(env, id, { before, limit = 50 })` → `adj:<id>:` newest first, paged.
- Routes (session):
  - `GET /api/inventory/products` → `{ products: [{ id, name, era, status, cover, variants, available, onHand, committed, low, out, stockCents? }], totals }` (`stockCents` and the cost totals are owners only).
  - `GET /api/inventory/products/:id` → `{ product, version, stock, history, media }`. `product` is the stored KV document (photo refs, `skus`, colour `ring` kept as stored), the one the page edits and sends back. `media` maps each ref's `photoPath` to its `manifestEntry` for display. `costCents` is removed for viewers.
  - `PUT /api/inventory/products/:id { opId, product, version }` (owner).
  - `GET /api/inventory/eras`; `PUT /api/inventory/eras/:slug { opId, era, version }` (owner); `PUT /api/inventory/era-order { opId, order, version }` (owner).
- Routes (token): `GET /api/admin/eras` → `{ eras: [{ slug, name, state }] }`; `POST /api/admin/eras { slug, name }` → draft era, or `409 era-exists`.
- `saveProduct` and `saveEra` log `product.saved` / `era.saved`.

- [ ] **Step 1: Write the failing tests**

```js
test('a stale product save is 409 product-changed with the current product, and nothing changes', async () => {});
test('colour and size names with |, empty, or over 100 characters are refused', async () => { /* Review Focus 3 */ });
test('renaming a colour moves its stock keys and SKUs in one commit; refused while committed > 0', async () => {});
test('removing a size with stock on hand is refused', async () => {});
test('an active product without a photo is refused; a draft one saves', async () => {});
test('field edits land in history with a summary', async () => { /* 'Price 32.99 → 34.99' */ });
test('viewers never receive costCents or stock at cost', async () => { /* list + detail */ });
test('saving bumps catalog:rev so the storefront shows the edit on its next request', async () => {});
test('publishing an era without a hero is refused; new-era creates a draft and refuses an existing slug', async () => {});
```

- [ ] **Step 2: Run them and see them fail**

Run: `node --test tests/catalog-save.test.mjs`
Expected: FAIL.

- [ ] **Step 3: Implement validation, saves, history and routes**

- [ ] **Step 4: Run the full suite**

Run: `node --test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server tests
git commit -m "feat(inventory): versioned product and era saves with history"
```

### Task 12: Photo uploads and media cleanup

**Files:**
- Modify: `server/routes/inventory.js`, `server/routes/admin.js`, `server/index.js`, `server/lib/media.js`
- Test: `tests/media-routes.test.mjs`

**Interfaces:**
- Consumes: `storePhoto` (Task 2); `saveProduct`, `saveEra` (Task 11).
- Produces:
  - `readBytes(req, max) → Promise<Uint8Array>` in `server/lib/http.js`, with the same 413 behaviour as `readJson`.
  - `PUT /api/inventory/media` (owner, write) and `PUT /api/admin/media` (token): body `multipart/form-data`, with one `file` part per variant and at most 1 MB in total. Parsed with `new Request(url, { method: 'POST', headers, body }).formData()`. Returns the `photoRef` from `storePhoto`. Logs `media.uploaded`.
  - `POST /api/admin/photos { era, target, color?, refs: [photoRef] }` (token): appends to the product's colour images (or product `images`), or sets the era `hero` when `target === 'hero'`. It saves through `saveProduct` / `saveEra` with a fresh version read, retried on 409 up to 3 times.
  - `cleanMedia(env, now) → Promise<number>`: deletes media files that no `era:` / `product:` references and whose `mtimeMs` is over 24 h old. It runs from `scheduled` once per Jamaica day, guarded by a `media-gc:<day>` KV marker.

- [ ] **Step 1: Write the failing tests**

```js
test('upload stores a variant set and returns its ref; a second identical upload is a no-op', async () => {});
test('upload refuses > 1 MB, non-multipart, a PNG and a viewer', async () => {});
test('the CLI photos endpoint attaches to a colour or sets the hero', async () => {});
test('cleanMedia removes only unreferenced files older than 24 hours, once per day', async () => {});
```

- [ ] **Step 2: Run them and see them fail**

Run: `node --test tests/media-routes.test.mjs`
Expected: FAIL.

- [ ] **Step 3: Implement `readBytes`, the upload and attach routes and `cleanMedia`**

- [ ] **Step 4: Run the full suite**

Run: `node --test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server tests
git commit -m "feat(media): photo upload, attach and daily cleanup"
```

### Task 13: Inventory UI, product list and product page

**Files:**
- Create: `assets/js/inventory-products.js`
- Modify: `assets/css/inventory.css`
- Test: `tests/inventory-products.test.mjs`

**Interfaces:**
- Consumes: Task 9 (`registerTab`, `api`, `newOpId`); Task 10 and 11 routes.
- Produces (pure, exported for tests):
  - `filterProducts(list, { q, chip, era }) → list`, where `chip` is `all | low | out | draft | archived` and `q` matches name or any SKU, case-insensitive.
  - `pendingSummary(original, edited, deltas) → { fields: string[], stockChanges: number, units: number, text }`, e.g. `text: 'Unsaved: 2 stock changes (+12)'`.
  - `saveAll({ productId, original, edited, deltas, reason, note }) → Promise<{ product?: 'ok' | error, stock?: 'ok' | error }>`. It sends the product save and the stock save as two requests, each with its own `opId`, created once per Save press and reused on retry. Each part's result is reported separately.
- UI, following the approved mockups (`.superpowers/brainstorm/1990-1793148163/content/inventory.html`, `product.html`):
  - list: search, chips, totals, rows with cover, badges `LOW` / `n OUT` / `DRAFT` / `ARCHIVED`, and Available;
  - product page: status, photos per colour (Task 14 fills in the uploader), details, pricing with a live margin "before GCT and fees", options, stock rows with − / + steppers showing Available and the pending delta, reason + note, a history list with "Load more", and a sticky save bar;
  - viewers get the same page with inputs disabled and no save bar.
  - On a 409 `product-changed`, the page shows the changed fields from `details.current` and keeps the owner's edits. On signed-out, the edits stay in memory and Save works again after login (Review Focus 5).
  - Leaving the page with unsaved edits asks first (`canLeave`).

- [ ] **Step 1: Write the failing tests**

```js
test('filterProducts matches name and SKU and applies chips', () => {});
test('pendingSummary counts stock changes and units', () => {
  assert.equal(pendingSummary(p, p, { 'Classic Black|M': 6, 'Classic Black|L': 6 }).text, 'Unsaved: 2 stock changes (+12)');
});
test('saveAll reuses its opIds on retry and reports product and stock results separately', async () => {});
test('after signed-out and login, saveAll still has the edits and succeeds', async () => { /* Review Focus 5, with api stub returning 401 then 200 */ });
```

- [ ] **Step 2: Run them and see them fail**

Run: `node --test tests/inventory-products.test.mjs`
Expected: FAIL.

- [ ] **Step 3: Build the tab**

Check it by hand at 375px and at 1024px against the mockups.

- [ ] **Step 4: Run the full suite**

Run: `node --test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add assets tests
git commit -m "feat(inventory): product list and product page with stock steppers"
```

### Task 14: Inventory UI, photo uploader and Eras section

**Files:**
- Create: `assets/js/inventory-photos.js`, `assets/js/inventory-eras.js`
- Modify: `assets/js/inventory-products.js`, `assets/css/inventory.css`
- Test: `tests/inventory-photos.test.mjs`

**Interfaces:**
- Consumes: `variantWidths`, `MAX_VARIANT_BYTES` (Task 1); `PUT /api/inventory/media` (Task 12); era routes (Task 11).
- Produces:
  - `encodeVariants(file, { createImageBitmap, makeCanvas }) → Promise<Blob[]>`:
    - decode with `imageOrientation: 'from-image'`;
    - draw each `variantWidths(bitmap.width)` width;
    - try `image/webp` and fall back to `image/jpeg` when the blob's type isn't webp (Safari). All variants use the same type;
    - step quality from 0.82 down by 0.06 to a floor of 0.5 until each blob is ≤ `MAX_VARIANT_BYTES`, else throw `'photo-too-large'`.
    The canvas factories are injectable for tests.
  - `uploadPhoto(file) → Promise<photoRef>`: posts `FormData` with one `file` part per variant.
  - Uploader on the product page: per-colour tabs, add (multi-file), drag to reorder (with keyboard up/down buttons for accessibility), remove. Changes join the product save.
  - Eras section (button on the list): eras in order with status `Draft` / `Live` / `Drops <date>` / `Ended` / `Archived` and product count; create, edit, publish, archive, and move up / down (owner); hero uploader.

- [ ] **Step 1: Write the failing tests**

```js
test('encodeVariants makes one blob per width, all one type, each under 250 KiB', async () => { /* fake canvas whose toBlob size scales with width*quality */ });
test('encodeVariants falls back to JPEG for every variant when WebP encoding is unsupported', async () => {});
test('encodeVariants steps quality down and gives up with photo-too-large', async () => {});
```

- [ ] **Step 2: Run them and see them fail**

Run: `node --test tests/inventory-photos.test.mjs`
Expected: FAIL.

- [ ] **Step 3: Build the uploader and the Eras section**

By hand, upload a phone JPEG with EXIF rotation from a real phone (or the Chrome device toolbar) and confirm it shows upright on the storefront at `/products/<id>`.

- [ ] **Step 4: Run the full suite**

Run: `node --test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add assets tests
git commit -m "feat(inventory): photo uploads and eras section"
```

### Task 15: CLI `new-era`, `photos` and `discount` against the server

**Files:**
- Modify: `scripts/new-era.mjs`, `scripts/photos.mjs`, `scripts/discount.mjs`, `tests/new-era.test.mjs`, `tests/photos.test.mjs`, `tests/data.test.mjs`
- Test: those three files

**Interfaces:**
- Consumes: `scripts/lib/admin-cli.mjs` (Task 8); `POST /api/admin/eras`, `GET /api/admin/eras` (Task 11); `PUT /api/admin/media`, `POST /api/admin/photos` (Task 12); `variantWidths` (Task 1).
- Produces:
  - `npm run new-era <slug> "<Name>" [local] [url=<base>]` → `newEra({ base, token, slug, name, fetchFn })`, which prints "Created draft era <slug> on <where>. Fill it in and publish it at <base>/inventory#inventory".
  - `npm run photos -- <era> <product-id|hero> [--color "<name>"] <photo…> [local] [url=<base>]` → `photoVariants(path) → Promise<Buffer[]>` (sharp: `rotate()`, resize to each `variantWidths(width)`, WebP quality 82 stepping down to 50 until ≤ 250 KiB; sharp strips metadata by default) and `addPhotos({ base, token, era, target, color, photos, fetchFn })`.
  - `discount.mjs` reads era slugs from `GET /api/admin/eras` instead of `data/eras/index.js`.
  - `tests/data.test.mjs` drops the "no era.js has a TODO left" test and keeps the seed-data checks.

- [ ] **Step 1: Rewrite the tests for the new behaviour**

```js
test('new-era posts slug and name and reports a draft', async () => {});
test('new-era refuses a bad slug before calling the server', async () => {});
test('photoVariants makes the standard widths under 250 KiB, upright, without EXIF', async () => { /* sharp-made 3000×2000 JPEG with orientation 6 → heights > widths; metadata has no exif */ });
test('addPhotos uploads then attaches with the token', async () => {});
test('discount checks era names against the server list', async () => {});
```

- [ ] **Step 2: Run them and see them fail**

Run: `node --test tests/new-era.test.mjs tests/photos.test.mjs tests/discount.test.mjs`
Expected: FAIL.

- [ ] **Step 3: Rewrite the three scripts**

- [ ] **Step 4: Run the full suite**

Run: `node --test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts tests
git commit -m "feat(cli)!: new-era, photos and discount work against the server's disk"
```

---

## Phase 4: Orders

### Task 16: Order flow rules

**Files:**
- Create: `server/lib/order-flow.js`
- Test: `tests/order-flow.test.mjs`

**Interfaces:**
- Produces (pure):
  - `FULFILMENT = ['UNFULFILLED', 'READY', 'FULFILLED', 'CANCELLED']`. `fulfilmentOf(record)` returns `'UNFULFILLED'` when the field is missing.
  - `applyAction(record, action, { by, now }) → { record, movements: [{ key, onHand, committed, reason }] }`. It throws `HttpError('invalid-action', 400)` on a disallowed transition or bad input. Actions:
    - `{ type: 'ready' }`: pickup orders only, from UNFULFILLED.
    - `{ type: 'fulfilled' }`: pickup from UNFULFILLED or READY, shipping from UNFULFILLED. Movements are On hand −qty and Committed −qty for each line not fully refunded, with reason `sold`.
    - `{ type: 'cancel', restock: boolean }`: from UNFULFILLED or READY. Committed −qty; also On hand −qty when `restock` is false. Reason `cancelled`.
    - `{ type: 'refund', lines: [{ key, qty }], amountCents, restock, reason }`: only when `paymentStatus` is `PAID` or `PARTIALLY_REFUNDED`. The refunded total can't exceed `totalCents`. `taxCents` is taken in proportion from the record's `taxCents` (0 when missing). Movements follow the spec's table: after fulfilment, a restock adds On hand back; before fulfilment, Committed −qty, plus On hand −qty without restock. It sets `paymentStatus` to `REFUNDED` when everything is refunded, else `PARTIALLY_REFUNDED`.
    - `{ type: 'note', text }`: 1–500 characters; no movements.
  Every action appends an event `{ at, type, by, … }`. Movements are empty when `record.stockCommitted !== true`.
  - `defaultRefundCents(record, lines) → number`: the chosen lines' `unitCents × qty`, plus their share of GCT. Never the processing fee.
  - `orderSummary(record) → { totalCents, payment, fulfilment, type, locationId, units, placedAt }` (no personal data; under 1 KiB).

- [ ] **Step 1: Write the failing tests**

```js
test('pickup goes UNFULFILLED → READY → FULFILLED; nothing leaves FULFILLED or CANCELLED', () => {});
test('shipping skips READY', () => {});
test('fulfilled moves on hand and committed down; cancel releases committed; no-restock cancel also lowers on hand', () => {});
test('refunds: only on paid orders, never above the total, fee never refunded, status becomes PARTIALLY_REFUNDED then REFUNDED', () => {});
test('orders without stockCommitted never produce movements', () => {});
test('orderSummary has no personal fields and fits in 1 KiB', () => {});
```

- [ ] **Step 2: Run them and see them fail**

Run: `node --test tests/order-flow.test.mjs`
Expected: FAIL.

- [ ] **Step 3: Implement `server/lib/order-flow.js`**

- [ ] **Step 4: Run the full suite**

Run: `node --test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/lib/order-flow.js tests/order-flow.test.mjs
git commit -m "feat(orders): pure fulfilment, cancel and refund rules"
```

### Task 17: Version-checked order writes and the actions endpoint

**Files:**
- Modify: `server/lib/orders.js`, `server/lib/delivery.js`, `server/lib/submissions.js`, `server/lib/checkout.js`, `server/routes/inventory.js`, `server/index.js`, `server/lib/http.js`
- Test: `tests/order-actions.test.mjs`, `tests/emails.test.mjs` (existing, must pass)

**Interfaces:**
- Consumes: Task 16; `stockKey`, `stockEntry`, `adjKey` (Tasks 3, 5); `opPut`, `readOp` (Task 10).
- Produces:
  - `changeOrder(env, id, change: (record) => record | { record, extraPuts }) → Promise<record>`: `getEntry`, apply, then one commit that checks the order's version and puts `order:` plus the `day:` entry with `metadata: orderSummary(record)`. It retries 5 times on a clash.
  - `updateOrder(env, record)` is removed. `delivery.js` uses `changeOrder(env, id, r => ({ ...r, email: record.email }))`, so email delivery only ever changes `email`.
  - `submitOrder` writes the `day:` entry with `metadata: orderSummary(record)`. `directRecord` adds `fulfilmentStatus: 'UNFULFILLED'` and `events: [{ at, type: 'placed', by: null }]`.
  - `POST /api/inventory/orders/:id/actions { opId, version, action }` (owner, write):
    - returns a stored `op:` result if there is one;
    - otherwise `getEntry`, version check, `applyAction`, then reads the movement variants;
    - one commit holds the order and day checks, the order put, the stock puts with their checks, the `adj:` puts (`orderId` set) and `opPut`;
    - responds with `{ order, version }`, or `409 order-changed` with `{ current }`.
    Logs `order.ready` / `order.fulfilled` / `order.cancelled` / `order.refunded`.

- [ ] **Step 1: Write the failing tests**

```js
test('an email retry landing after an owner action keeps the action', async () => { /* mark ready, then run retryEmails for that order → fulfilmentStatus still READY */ });
test('an action with a stale version is 409 order-changed and changes nothing', async () => {});
test('a repeated opId applies an action once', async () => {});
test('fulfilling an order moves stock and writes adj records with the order id', async () => {});
test('actions on orders placed before inventory never touch stock', async () => {});
test('day index metadata follows every order change', async () => {});
```

- [ ] **Step 2: Run them and see them fail**

Run: `node --test tests/order-actions.test.mjs`
Expected: FAIL.

- [ ] **Step 3: Implement `changeOrder`, the delivery change, the placement additions and the route**

- [ ] **Step 4: Run the full suite**

Run: `node --test`
Expected: PASS, including the existing email and checkout tests.

- [ ] **Step 5: Commit**

```bash
git add server tests
git commit -m "feat(orders): version-checked order writes and owner actions"
```

### Task 18: Retention, keep the money and delete the people

**Files:**
- Create: `server/lib/retention.js`
- Modify: `server/lib/orders.js`, `server/lib/submissions.js`, `server/index.js` (`scheduled`)
- Test: `tests/retention.test.mjs`

**Interfaces:**
- Consumes: `changeOrder` (Task 17).
- Produces:
  - New `order:` and `day:` writes carry no `expirationTtl`. `submission:` keeps `ORDER_TTL`, and digest keys keep theirs.
  - `PERSONAL_FIELDS = ['customer', 'payer', 'notes', 'shipto', 'shipping', 'personal']`, which covers today's fields and the WiPay design's address and encrypted fields.
  - `scrubOrders(env, now, { deadline }) → Promise<number>`: walks the `day:` keys for days more than 2 years before `now`. For each order without `scrubbedAt`, it deletes `PERSONAL_FIELDS` through `changeOrder` and sets `scrubbedAt`. Ids, lines, totals, statuses, refunds and events are kept.
  - `dropOrderTtls(env, { deadline }) → Promise<boolean>`: a one-time rewrite of existing `order:` / `day:` keys without TTL. It resumes from a `retention:ttl-cursor` key and sets `retention:ttl-done` when finished.
  - Both run from `scheduled`, once per Jamaica day, guarded by a `retention:<day>` marker. Both respect `c.deadline`.

- [ ] **Step 1: Write the failing tests**

```js
test('orders placed over 2 years ago lose only personal fields, once', async () => {});
test('orders 2 years old minus a day are untouched', async () => {});
test('the TTL rewrite removes order and day TTLs, resumes across runs and then stops', async () => {});
test('new orders are stored without a TTL; submissions keep theirs', async () => {});
```

- [ ] **Step 2: Run them and see them fail**

Run: `node --test tests/retention.test.mjs`
Expected: FAIL.

- [ ] **Step 3: Implement `server/lib/retention.js` and the scheduling**

- [ ] **Step 4: Run the full suite**

Run: `node --test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server tests
git commit -m "feat(orders): keep order records; scrub personal data after 2 years"
```

### Task 19: Orders tab

**Files:**
- Create: `assets/js/inventory-orders.js`
- Modify: `server/routes/inventory.js`, `server/index.js`, `assets/css/inventory.css`
- Test: `tests/orders-routes.test.mjs`, `tests/inventory-orders.test.mjs`

**Interfaces:**
- Consumes: Tasks 16 to 18.
- Produces:
  - `GET /api/inventory/orders?view=open|ready|awaiting|fulfilled|cancelled|all&from=&to=&location=&payment=&product=&q=&cursor=`:
    - one paged `list` over `day:` keys in `[from, to]` (default: last 30 days), filtered on metadata;
    - `product` and `q` load the orders in range (`q`, which matches name or phone, is owners only, and viewers get 403);
    - returns `{ orders: [summary + id], cursor }`, 50 per page;
    - the Open view is payment `PAID` or `NOT_COLLECTED` with fulfilment `UNFULFILLED` or `READY`.
  - `GET /api/inventory/orders/:id` → `{ order, version }`. For viewers, `customer`, `payer`, `notes`, note events and line `costCents` are removed, and so are any `PERSONAL_FIELDS`. Scrubbed orders return `scrubbed: true`.
  - UI per `orders.html` mockup:
    - views, search and filters;
    - rows with badges, and a refund-window countdown for WiPay orders that have `paidAt`;
    - the detail page with lines, totals rows present on the record, cost of goods (owners), customer and pickup (owners), timeline and notes;
    - action buttons (owners): Mark ready / Mark picked up or Mark shipped / Record refund / Cancel. Cancel confirms "Put items back in stock?" (default yes) and, if paid, adds "Refund it in the WiPay dashboard, then record the refund here." Record refund picks lines and quantities, prefills `defaultRefundCents`, and has restock and reason;
    - "Customer details removed after 2 years" on scrubbed orders.
  - Pure helper for tests: `actionsFor(order, role) → string[]`.

- [ ] **Step 1: Write the failing tests**

```js
test('the open view lists paid and not-collected unfulfilled or ready orders from metadata only', async () => { /* spy: no order: gets */ });
test('order lists past 1000 day keys page with cursor', async () => { /* Review Focus 4 */ });
test('viewers get no personal data, cost or notes, and 403 on name search', async () => {});
test('actionsFor offers ready only on pickup orders and nothing after fulfilment, and nothing to viewers', () => {});
```

- [ ] **Step 2: Run them and see them fail**

Run: `node --test tests/orders-routes.test.mjs tests/inventory-orders.test.mjs`
Expected: FAIL.

- [ ] **Step 3: Implement the routes and the tab**

Check it by hand against the mockup at 375px and 1024px.

- [ ] **Step 4: Run the full suite**

Run: `node --test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server assets tests
git commit -m "feat(inventory): orders tab with history, views and owner actions"
```

---

## Phases 5 to 7: Stats, Logs, pull

### Task 20: Stats

**Files:**
- Create: `server/lib/stats.js`, `assets/js/inventory-stats.js`
- Modify: `server/routes/inventory.js`, `server/index.js`, `assets/css/inventory.css`
- Test: `tests/stats.test.mjs`

**Interfaces:**
- Produces:
  - `periodBounds(period, now, { from, to }) → { from, to, prevFrom, prevTo }`: Jamaica days; `today`, `7d`, `30d` or `custom`.
  - `computeStats(orders, catalog, stock, bounds) → { tiles: { sales, orders, units, average, prev }, perDay: [{ day, cents, orders }], best: { product, era, colour, size }, sizes, pickup, low }`:
    - counts placed, not-cancelled orders and excludes `AWAITING_PAYMENT`;
    - refunded quantities come off units;
    - `low` lists the variants with Available ≤ `lowStockAt`, worst first;
    - `sales` is order value (sum of `totalCents`).
  - `GET /api/inventory/stats?period=&from=&to=` (viewer or owner), cached in memory per `(period, from, to)` until any order changes. Every order write bumps an in-process `ordersRev`.
  - UI per the `stats-finances.html` mockup, left side:
    - tile label "Sales (order value)";
    - a single-series SVG bar chart in `#3987e5` with 4px rounded tops anchored to the baseline, a 2px gap and recessive grid. It has a per-bar hover/focus tooltip (day, amount, orders) and a "Show as table" toggle;
    - the best-sellers bar list, sizes, pickup split and running-low list. Status colours always come with an icon and label.

- [ ] **Step 1: Write the failing tests**

```js
test('stats count placed orders, exclude cancelled and awaiting payment, subtract refunded units', () => {});
test('previous period has the same length', () => {});
test('Jamaica day boundaries put a 23:30 UTC-5 order on its local day', () => {});
test('running-low lists variants at or under lowStockAt, worst first', () => {});
```

- [ ] **Step 2: Run them and see them fail**

Run: `node --test tests/stats.test.mjs`
Expected: FAIL.

- [ ] **Step 3: Implement the aggregation, route and tab**

- [ ] **Step 4: Run the full suite**

Run: `node --test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server assets tests
git commit -m "feat(inventory): stats tab"
```

### Task 21: Logs and health

**Files:**
- Create: `server/lib/log-store.js`, `assets/js/inventory-logs.js`
- Modify: `server/lib/log.js`, `server/index.js`, `main.js`, `server/routes/inventory.js`, `assets/css/inventory.css`
- Test: `tests/log-store.test.mjs`

**Interfaces:**
- Produces:
  - `createLogger(base, { sink } = {})`: `sink(line)` is called after `redact` for lines `shouldSave(line)` accepts. `main.js` and `createApp` pass `logSink(env, waitUntil)`, which writes `log:<ts>:<random>` with a 30-day TTL (`2592000`) and swallows every error.
  - `shouldSave(line)` accepts:
    - level `error`;
    - `request` with `status >= 500`;
    - `warn` lines whose event isn't `request`;
    - these events: `login.ok`, `login.failed`, `login.blocked`, `account.added`, `account.removed`, `sales.updated`, `era.saved`, `product.saved`, `stock.adjusted`, `media.uploaded`, `order.placed`, `order.ready`, `order.fulfilled`, `order.cancelled`, `order.refunded`, `inventory.pulled`.
  - A comment in `log.js` saying `PII_KEYS` covers customers and that `account` is staff-only. `account` is not in `PII_KEYS`.
  - `GET /api/inventory/logs?level=&kind=&before=` (owner) → newest first, 100 per page.
  - `GET /api/inventory/health` (owner) → `/api/health` data plus:
    - `operations`;
    - free disk bytes (from `env.DISK_FREE?.()`, set in `main.js` from the existing `statfs` check);
    - media folder bytes;
    - `lastCronAt` (a `cron:lastRun` key the scheduled job writes);
    - the `email-retry:` count;
    - the latest `digest-sent:` day;
    - `catalog:rev`.
  - Logs tab: level and kind filters, "Load more", and the health panel.

- [ ] **Step 1: Write the failing tests**

```js
test('only the listed lines are saved, after redaction, with a 30-day TTL', async () => {});
test('a failing sink never fails or delays the request', async () => {});
test('bot 404s and 429s are not saved', async () => {});
test('logs and health are owner-only', async () => {});
```

- [ ] **Step 2: Run them and see them fail**

Run: `node --test tests/log-store.test.mjs`
Expected: FAIL.

- [ ] **Step 3: Implement the sink, routes and tab**

- [ ] **Step 4: Run the full suite**

Run: `node --test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server main.js assets tests
git commit -m "feat(inventory): logs and health panel"
```

### Task 22: `npm run inventory:pull`

**Files:**
- Create: `scripts/inventory-pull.mjs`
- Modify: `server/routes/admin.js`, `server/index.js`, `server/lib/catalog-store.js`, `package.json`, `.env.example`, `README.md`
- Test: `tests/inventory-pull.test.mjs`

**Interfaces:**
- Consumes: `admin-cli.mjs` (Task 8); catalog keys (Task 3); `mediaStore` (Task 2).
- Produces:
  - `GET /api/admin/export` (token) → `{ rev, eraOrder, eras: [{ value, key }], products: [...], stock: [...], media: [names] }`. No orders, accounts, sessions or logs.
  - `PUT /api/admin/import` (token): 404 unless `env.ENVIRONMENT === 'development'` and `ctx.ip` is loopback (`127.0.0.1`, `::1` or `::ffff:127.0.0.1`). It replaces every `era:`, `product:`, `stock:` and `catalog:rev` key with the export, deletes local ones that aren't in the export, and writes a new `rev`, in commits of at most 400 mutations. The last commit writes `catalog:rev`. Logs `inventory.pulled`.
  - `PUT /api/admin/media/<name>` (token, raw body, `MEDIA_NAME`, ≤ 250 KiB, sniff check) stores one file. Pull uses it for missing files.
  - `scripts/inventory-pull.mjs [url=<base>]`:
    - source is `url` or `PROD_URL` with `PROD_ADMIN_TOKEN`; target is `LOCAL_URL` with `ADMIN_TOKEN`;
    - exports, downloads each `/media/<name>` the local server lacks (HEAD check), uploads it, then imports;
    - prints counts. Rerunning gives the same result.
  - `package.json`: `"inventory:pull": "node --env-file-if-exists=.env scripts/inventory-pull.mjs"`. `.env.example` adds `PROD_ADMIN_TOKEN=` with a comment.

- [ ] **Step 1: Write the failing tests**

```js
test('export has catalog, stock and media names and no orders, accounts or logs', async () => {});
test('import is 404 in production and from a non-loopback address', async () => {});
test('import replaces the local catalog and stock, and a second import changes nothing', async () => {});
test('pull uses the production token for export and the local token for import', async () => {});
```

- [ ] **Step 2: Run them and see them fail**

Run: `node --test tests/inventory-pull.test.mjs`
Expected: FAIL.

- [ ] **Step 3: Implement the endpoints and the script; add a README paragraph**

- [ ] **Step 4: Run the full suite**

Run: `node --test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts server package.json .env.example README.md tests
git commit -m "feat(cli): inventory:pull copies the live catalog to local"
```

### Task 23: Amend the WiPay plan

**Files:**
- Modify: `docs/superpowers/plans/2026-10-24-wipay-payments.md`

**Interfaces:**
- Consumes: the spec's "For WiPay" and "Finances" sections.

- [ ] **Step 1: Add the inventory work to the WiPay plan**

Add tasks for each of these:
- An `AWAITING_PAYMENT` order commits stock with `holdUntil` = now + 15 minutes, using `submitOrder`'s stock step.
- Payment success clears the hold. The 15-minute job, and any checkout that finds too little stock, releases expired holds with a commit guarded on the order still being `AWAITING_PAYMENT`.
- A late success after a release is accepted and alerts the owner once.
- Line `costCents` is refreshed at payment.
- The `day:` entry is written at creation on the placed day, as already done by Task 17, not at payment. Add `paid:<date>:<id>` and `refund:<date>:<id>` index entries.
- `PERSONAL_FIELDS` must cover the address and encrypted fields.
- The Finances tab, per the spec and the `stats-finances.html` mockup, right side: revenue, refunds, net, GCT owed, WiPay fees (`PROCESSING_FEE.bps`), cost of goods, profit, margin, best sellers by profit, refunds list, by-month, CSV without personal data, and the "No payments collected yet" empty state.
- The rollout sets `STATUS=live`.

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/plans/2026-10-24-wipay-payments.md
git commit -m "docs(plan): fold inventory holds, indexes and Finances into the WiPay plan"
```
