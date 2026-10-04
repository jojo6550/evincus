# Era Folders Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `data/eras.json` + `data/products.json` with one folder per era (`data/eras/<slug>/era.js` + `img/`), download the stand-in Shopify photos into the repo, and add an `npm run new-era` scaffold.

**Architecture:** Each era folder exports `era` and `products` with bare image filenames. `data/eras/index.js` lists eras newest first and calls `merge()` (in `data/eras/merge.js`) to produce `CATALOG = { eras, products }` in today's exact shape, with filenames expanded to site-relative paths (`data/eras/<slug>/img/<file>`). The Worker bundle and the site's static fallback import that module instead of the JSON. Tests enforce the folder rules.

**Tech Stack:** Vanilla ES modules, Node ≥22 (`node --test`, built-in `fetch`), Cloudflare Worker via wrangler (esbuild bundles relative imports), GitHub Pages. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-03-era-folders-design.md`

## Global Constraints

- No new npm dependencies. Scripts use Node built-ins only.
- Node ≥22, ES modules (`"type": "module"`).
- Era photos live only in `data/eras/<slug>/img/`. Non-era photos live in `assets/img/` (stand-in site photos in `assets/img/site/`).
- Image fields in `era.js` are bare filenames. Allowed names: `/^[a-z0-9]+(-[a-z0-9]+)*\.(jpg|png|webp)$/` (lowercase, no spaces; GitHub Pages is case-sensitive, Windows is not).
- No era image over 500 KB (`500 * 1024` bytes).
- Era photo names: `hero.<ext>`, `<product-id>-<n>.<ext>`, `<product-id>-<colour-slug>-<n>.<ext>`.
- The merged catalog keeps today's shape: `data/catalog.js`, `worker/src/lib/pricing.js`, routes and page rendering are not modified.
- No inline CSS/JS; CSS only in `assets/css`, JS only in `assets/js` (site), `data/`, `worker/`, `scripts/`.
- Mobile first: manual checks happen at 375 px width first.
- Every commit leaves `node --test` green.

## Review Focus

1. **Product with images only on colours** (e.g. `disaster-zone-tee`, `99-tee` have no product-level `images`): `merge()` must not add an `images` key, so `imagesFor()` still falls through to colour images. Pinned in Task 1.
2. **Photo name that works on Windows but 404s on Pages** (`Hero.JPG`, `IMG 0123.jpg`): data test must check exact-case presence via directory listing and the safe-name regex, not `existsSync`. Pinned in Task 3.
3. **Era name with quotes/apostrophes** (`Rock 'n' "Roll"`): the scaffolded `era.js` must still import and round-trip the name exactly. Pinned in Task 4.
4. **`new-era` failure leaves no partial state** (bad slug, missing name, duplicate slug, `index.js` missing its markers): nothing on disk changes. Pinned in Task 4.
5. **API down**: the static fallback must render local photos on era pages, product view and bag. Pinned as a manual check in Task 5.

---

### Task 1: `merge()` — era modules → catalog shape

**Files:**
- Create: `data/eras/merge.js`
- Test: `tests/merge.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: `merge(modules: Array<{ era: Era, products: Product[] }>) => { eras: Era[], products: Product[] }`. Era `hero` and product `images` / `colors[].images` filenames become `data/eras/<slug>/img/<file>`; every product gets `era: <slug>`. No validation, no mutation of inputs. Also `imgPath(slug, file) => string`.

- [ ] **Step 1: Write the failing test**

`tests/merge.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { merge, imgPath } from '../data/eras/merge.js';

const modules = () => [
  {
    era: { slug: 'alpha', name: 'Alpha', tagline: 'T', story: 'S', hero: 'hero.jpg', dropsAt: null, endsAt: null },
    products: [
      { id: 'a-tee', name: 'A Tee', images: ['a-tee-1.jpg'],
        colors: [{ name: 'Black', hex: '#000000', images: ['a-tee-black-1.png'] }, { name: 'White', hex: '#FFFFFF' }] },
      { id: 'a-hood', name: 'A Hood', images: ['a-hood-1.jpg'], colors: [{ name: 'Black', hex: '#000000' }] },
    ],
  },
  {
    era: { slug: 'beta', name: 'Beta', tagline: 'T', story: 'S', hero: 'hero.png', dropsAt: null, endsAt: null },
    products: [
      { id: 'b-tee', name: 'B Tee', colors: [{ name: 'Black', hex: '#000000', images: ['b-tee-black-1.jpg'] }] },
    ],
  },
];

test('imgPath builds a site-relative path', () => {
  assert.equal(imgPath('alpha', 'hero.jpg'), 'data/eras/alpha/img/hero.jpg');
});

test('expands filenames, stamps era, keeps era and product order', () => {
  assert.deepEqual(merge(modules()), {
    eras: [
      { slug: 'alpha', name: 'Alpha', tagline: 'T', story: 'S', hero: 'data/eras/alpha/img/hero.jpg', dropsAt: null, endsAt: null },
      { slug: 'beta', name: 'Beta', tagline: 'T', story: 'S', hero: 'data/eras/beta/img/hero.png', dropsAt: null, endsAt: null },
    ],
    products: [
      { id: 'a-tee', era: 'alpha', name: 'A Tee', images: ['data/eras/alpha/img/a-tee-1.jpg'],
        colors: [
          { name: 'Black', hex: '#000000', images: ['data/eras/alpha/img/a-tee-black-1.png'] },
          { name: 'White', hex: '#FFFFFF' },
        ] },
      { id: 'a-hood', era: 'alpha', name: 'A Hood', images: ['data/eras/alpha/img/a-hood-1.jpg'],
        colors: [{ name: 'Black', hex: '#000000' }] },
      { id: 'b-tee', era: 'beta', name: 'B Tee',
        colors: [{ name: 'Black', hex: '#000000', images: ['data/eras/beta/img/b-tee-black-1.jpg'] }] },
    ],
  });
});

test('a product with only colour images gets no images key', () => {
  const b = merge(modules()).products.find(p => p.id === 'b-tee');
  assert.equal('images' in b, false);
  assert.equal('images' in merge(modules()).products[0].colors[1], false);
});

test('does not mutate the era modules', () => {
  const input = modules();
  const before = structuredClone(input);
  merge(input);
  assert.deepEqual(input, before);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/merge.test.mjs`
Expected: FAIL with `Cannot find module` … `data/eras/merge.js`

- [ ] **Step 3: Write minimal implementation**

`data/eras/merge.js`:

```js
// Turns the era folders into the catalog shape the rest of the code uses: { eras, products }.
// Image fields in era.js are bare filenames; here they become paths relative to the site root.
// No validation: tests/data.test.mjs checks the real catalog.

export const imgPath = (slug, file) => `data/eras/${slug}/img/${file}`;

const withPaths = (slug, files) => files.map(f => imgPath(slug, f));

export function merge(modules) {
  const eras = modules.map(({ era }) => ({ ...era, hero: imgPath(era.slug, era.hero) }));
  const products = modules.flatMap(({ era, products }) =>
    products.map(({ id, ...p }) => ({
      id,
      era: era.slug,
      ...p,
      ...(p.images && { images: withPaths(era.slug, p.images) }),
      colors: p.colors.map(c => (c.images ? { ...c, images: withPaths(era.slug, c.images) } : c)),
    })),
  );
  return { eras, products };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/merge.test.mjs`
Expected: PASS (4 tests)

- [ ] **Step 5: Run the full suite**

Run: `node --test`
Expected: all pass, `# fail 0`

- [ ] **Step 6: Commit**

```bash
git add data/eras/merge.js tests/merge.test.mjs
git commit -m "Add merge() for era folders"
```

---

### Task 2: Migrate the catalog into era folders and download stand-in photos

Generates the era folders, `data/eras/index.js`, local photos, and rewrites `index.html` / `data/site.json` to local site photos. The JSON files stay in place this task, so every consumer and test still works; the script verifies the new catalog matches the old one.

**Files:**
- Create: `scripts/migrate-era-folders.mjs` (deleted in Task 3)
- Generated: `data/eras/index.js`, `data/eras/{catastrophe,reflection,core}/era.js`, `data/eras/*/img/*`, `assets/img/site/*.jpg`
- Modify (by the script): `index.html` (4 photo URLs, 5 occurrences), `data/site.json` (lookbook URLs)

**Interfaces:**
- Consumes: `merge` from `data/eras/merge.js` (Task 1), imported by the generated `index.js`.
- Produces:
  - `data/eras/index.js` exporting `FOLDERS: string[]` (era slugs, newest first) and `CATALOG: { eras, products }`.
  - `index.js` contains two marker lines used by Task 4: `// eras:imports` (era imports follow it) and `// eras:list` (inside `const ERAS = [`, entries follow it).
  - Era module identifiers are `era_<slug with - replaced by _>`, e.g. `era_catastrophe`.

- [ ] **Step 1: Write the migration script**

`scripts/migrate-era-folders.mjs`:

```js
// One-off: moves data/eras.json + data/products.json into data/eras/<slug>/ folders and downloads the
// stand-in Shopify photos. Run once (`node scripts/migrate-era-folders.mjs`), commit the output, delete this file.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { deepStrictEqual } from 'node:assert';

const root = new URL('../', import.meta.url);
const read = p => JSON.parse(readFileSync(new URL(p, root), 'utf8'));
const eras = read('data/eras.json');
const products = read('data/products.json');
const MAX = 500 * 1024;

const slugify = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const ident = slug => `era_${slug.replace(/-/g, '_')}`;
const toJs = v => JSON.stringify(v, null, 2).replace(/^(\s*)"([A-Za-z_$][\w$]*)":/gm, '$1$2:');
const hasAlpha = b => b[0] === 0x89 && b[1] === 0x50 && [4, 6].includes(b[25]); // PNG colour type 4 or 6
const extOf = type => ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' })[type.split(';')[0].trim()];

async function get(url, params) {
  const u = new URL(url);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
  const res = await fetch(u);
  if (!res.ok) throw new Error(`${u} -> ${res.status}`);
  const type = res.headers.get('content-type') ?? '';
  const ext = extOf(type);
  if (!ext) throw new Error(`${u} -> unexpected content-type "${type}"`);
  return { bytes: Buffer.from(await res.arrayBuffer()), ext };
}

// 1200 px. PNGs with an alpha channel stay PNG; everything else becomes progressive JPEG. Retry smaller if too big.
async function download(url) {
  for (const width of [1200, 1000]) {
    let img = await get(url, { width });
    if (!(img.ext === 'png' && hasAlpha(img.bytes))) img = await get(url, { width, format: 'pjpg' });
    if (img.bytes.length <= MAX) return img;
  }
  throw new Error(`${url} is over 500 KB even at 1000 px`);
}

const eraDir = slug => new URL(`data/eras/${slug}/`, root);
const saved = new Map(); // `${slug} ${url}` -> filename

async function save(slug, url, base) {
  const key = `${slug} ${url}`;
  if (saved.has(key)) return saved.get(key);
  const { bytes, ext } = await download(url);
  const file = `${base}.${ext}`;
  writeFileSync(new URL(`img/${file}`, eraDir(slug)), bytes);
  saved.set(key, file);
  console.log(`data/eras/${slug}/img/${file}  ${Math.round(bytes.length / 1024)} KB`);
  return file;
}

// 1. Era folders
for (const era of eras) {
  mkdirSync(new URL('img/', eraDir(era.slug)), { recursive: true });
  const hero = await save(era.slug, era.hero, 'hero');
  const out = [];
  for (const p of products.filter(x => x.era === era.slug)) {
    const { era: _era, ...q } = p;
    if (p.images) {
      q.images = [];
      for (const [i, u] of p.images.entries()) q.images.push(await save(era.slug, u, `${p.id}-${i + 1}`));
    }
    q.colors = [];
    for (const c of p.colors) {
      if (!c.images) { q.colors.push(c); continue; }
      const images = [];
      for (const [i, u] of c.images.entries()) images.push(await save(era.slug, u, `${p.id}-${slugify(c.name)}-${i + 1}`));
      q.colors.push({ ...c, images });
    }
    out.push(q);
  }
  writeFileSync(
    new URL('era.js', eraDir(era.slug)),
    `// ${era.name}. Photos live in ./img and are referenced by filename.\n\n` +
      `export const era = ${toJs({ ...era, hero })};\n\nexport const products = ${toJs(out)};\n`,
  );
}

// 2. Index
writeFileSync(
  new URL('data/eras/index.js', root),
  `// Era order, newest first. \`npm run new-era\` adds new eras below both markers.
import { merge } from './merge.js';
// eras:imports
${eras.map(e => `import * as ${ident(e.slug)} from './${e.slug}/era.js';`).join('\n')}

const ERAS = [
  // eras:list
${eras.map(e => `  ${ident(e.slug)},`).join('\n')}
];

export const FOLDERS = ERAS.map(m => m.era.slug);
export const CATALOG = merge(ERAS);
`,
);

// 3. Non-era site photos -> assets/img/site/
const SITE_RE = /https:\/\/evincus\.shop\/cdn\/shop\/files\/([A-Za-z0-9_-]+)\.jpg\?[^"\s]*/g;
const siteFiles = ['index.html', 'data/site.json'];
const local = new Map(); // url -> local path
mkdirSync(new URL('assets/img/site/', root), { recursive: true });
for (const file of siteFiles) {
  for (const [url, name] of readFileSync(new URL(file, root), 'utf8').matchAll(SITE_RE)) {
    if (local.has(url)) continue;
    const { bytes, ext } = await get(url, { format: 'pjpg' });
    const path = `assets/img/site/${slugify(name)}.${ext}`;
    writeFileSync(new URL(path, root), bytes);
    local.set(url, path);
    console.log(`${path}  ${Math.round(bytes.length / 1024)} KB`);
  }
}
for (const file of siteFiles) {
  const text = readFileSync(new URL(file, root), 'utf8');
  writeFileSync(new URL(file, root), text.replace(SITE_RE, url => local.get(url)));
}

// 4. Verify: the new catalog equals the old one with each URL swapped for its downloaded file.
const { CATALOG } = await import(new URL('data/eras/index.js', root).href);
const path = (slug, url) => `data/eras/${slug}/img/${saved.get(`${slug} ${url}`)}`;
const expected = {
  eras: eras.map(e => ({ ...e, hero: path(e.slug, e.hero) })),
  products: eras.flatMap(e => products.filter(p => p.era === e.slug)).map(p => ({
    ...p,
    ...(p.images && { images: p.images.map(u => path(p.era, u)) }),
    colors: p.colors.map(c => (c.images ? { ...c, images: c.images.map(u => path(p.era, u)) } : c)),
  })),
};
deepStrictEqual(CATALOG, expected);
deepStrictEqual(CATALOG.products.map(p => p.id), products.map(p => p.id));
console.log(`Verified: ${CATALOG.eras.length} eras, ${CATALOG.products.length} products, ${saved.size} era photos, ${local.size} site photos.`);
```

- [ ] **Step 2: Run it**

Run: `node scripts/migrate-era-folders.mjs`
Expected: one line per downloaded file (each era photo ≤ 500 KB), ending with
`Verified: 3 eras, 9 products, <n> era photos, 4 site photos.`
If it throws `AssertionError`, the diff shows which field differs; fix the script, delete `data/eras/*/` (not `merge.js`) and `assets/img/site/`, `git checkout index.html data/site.json`, rerun.

- [ ] **Step 3: Inspect the output**

Run: `git status --short && git diff index.html data/site.json && cat data/eras/index.js && head -40 data/eras/core/era.js`
Expected:
- `index.html`: 5 `src` attributes now `assets/img/site/img-05xx.jpg`, nothing else changed.
- `data/site.json`: 4 lookbook entries now `assets/img/site/img-05xx.jpg`.
- `index.js` has `// eras:imports` and `// eras:list` markers, eras in order catastrophe, reflection, core.
- `era.js` uses unquoted keys, bare filenames, no `era` key on products.

- [ ] **Step 4: Open two photos to confirm they are real images**

Use the Read tool on `data/eras/catastrophe/img/hero.jpg` and one PNG under `data/eras/core/img/`. Expected: recognisable product/hero images.

- [ ] **Step 5: Run the full suite**

Run: `node --test`
Expected: all pass (JSON files still drive the existing tests).

- [ ] **Step 6: Commit**

```bash
git add scripts/migrate-era-folders.mjs data/eras assets/img/site index.html data/site.json
git commit -m "Generate era folders and download stand-in photos"
```

---

### Task 3: Switch consumers to era folders, enforce folder rules, delete the JSON

**Files:**
- Modify: `worker/src/lib/catalog.js` (whole file, 6 lines)
- Modify: `assets/js/store.js:1-4,28-32,42-44`
- Rewrite: `tests/data.test.mjs`
- Delete: `data/eras.json`, `data/products.json`, `tests/fixtures/images-snapshot.json`, `scripts/migrate-era-folders.mjs`

**Interfaces:**
- Consumes: `CATALOG`, `FOLDERS` from `data/eras/index.js` (Task 2); `imagesFor` from `data/catalog.js`.
- Produces: `worker/src/lib/catalog.js` keeps exporting `CATALOG = { eras, products, site }` (used by `worker/src/index.js:1`).

- [ ] **Step 1: Rewrite the data test (new checks first)**

`tests/data.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { imagesFor } from '../data/catalog.js';
import { CATALOG, FOLDERS } from '../data/eras/index.js';

const root = new URL('../', import.meta.url);
const { eras, products } = CATALOG;
const site = JSON.parse(readFileSync(new URL('data/site.json', root), 'utf8'));
const erasDir = new URL('data/eras/', root);
const dirs = readdirSync(erasDir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const IMAGE_NAME = /^[a-z0-9]+(-[a-z0-9]+)*\.(jpg|png|webp)$/;
const MAX_BYTES = 500 * 1024;

test('every era folder is listed in index.js and every listed era has a folder', () => {
  assert.deepEqual([...dirs].sort(), [...FOLDERS].sort());
});

test('each era.js declares the slug of its folder', async () => {
  for (const dir of dirs) {
    const { era } = await import(new URL(`${dir}/era.js`, erasDir).href);
    assert.equal(era.slug, dir, `data/eras/${dir}/era.js has slug "${era.slug}"`);
  }
});

test('era photos are bare, safely named files in their own img folder', () => {
  for (const e of eras) {
    const prefix = `data/eras/${e.slug}/img/`;
    const files = readdirSync(new URL(`${e.slug}/img/`, erasDir)); // exact case: Pages is case-sensitive
    const refs = [e.hero, ...products.filter(p => p.era === e.slug).flatMap(p => [
      ...(p.images ?? []),
      ...p.colors.flatMap(c => c.images ?? []),
    ])];
    for (const ref of refs) {
      assert.ok(ref.startsWith(prefix), `${ref} is not in ${prefix}`);
      const file = ref.slice(prefix.length);
      assert.match(file, IMAGE_NAME, `${e.slug}: "${file}" must be a bare lowercase-kebab .jpg/.png/.webp filename`);
      assert.ok(files.includes(file), `${prefix}${file} is missing (names are case-sensitive)`);
    }
  }
});

test('no era photo is over 500 KB', () => {
  for (const dir of dirs) {
    for (const file of readdirSync(new URL(`${dir}/img/`, erasDir))) {
      const { size } = statSync(new URL(`${dir}/img/${file}`, erasDir));
      assert.ok(size <= MAX_BYTES, `data/eras/${dir}/img/${file} is ${Math.round(size / 1024)} KB (max 500 KB)`);
    }
  }
});

test('site.json does not use era photos', () => {
  assert.ok(!JSON.stringify(site).includes('data/eras/'), 'non-era photos belong in assets/img/');
});

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

test('site data is present', () => {
  assert.ok(site.categories.some(c => c.id === 'all'));
  assert.ok(site.lookbook.length > 0);
  assert.ok(typeof site.careNote === 'string' && site.careNote);
});
```

- [ ] **Step 2: Prove the photo check catches a Windows-only name**

Run (Git Bash):
```bash
cd data/eras/core/img && f=$(ls | head -1) && mv "$f" tmp && mv tmp "$(echo "$f" | tr a-z A-Z)" && cd - && node --test tests/data.test.mjs; cd data/eras/core/img && F=$(ls | grep -E '^[A-Z0-9.-]+$' | head -1) && mv "$F" tmp && mv tmp "$(echo "$F" | tr A-Z a-z)" && cd -
```
Expected: `era photos are bare, safely named files…` FAILS with `… is missing (names are case-sensitive)` (or the hero/regex message); the rename is undone afterwards. Confirm `git status --short data/eras` shows nothing.

- [ ] **Step 3: Run the new data test**

Run: `node --test tests/data.test.mjs`
Expected: PASS (8 tests).

- [ ] **Step 4: Point the Worker at the era folders**

`worker/src/lib/catalog.js` (replace whole file):

```js
// The catalog bundled into the Worker at deploy. Era data lives in data/eras/, rules in data/catalog.js.
import { CATALOG as ERA_CATALOG } from '../../../data/eras/index.js';
import site from '../../../data/site.json' with { type: 'json' };

export const CATALOG = { ...ERA_CATALOG, site };
```

- [ ] **Step 5: Point the site's static fallback at the era folders**

In `assets/js/store.js`, replace lines 1-4:

```js
// The site's copy of the catalog. Loaded once at startup; pages read it synchronously after that.
// The API is the source of truth. If it can't be reached, the bundled era catalog keeps browsing working,
// with every product marked unbuyable so checkout stays off.
import { publicView, findProduct as find } from '../../data/catalog.js';
import { CATALOG } from '../../data/eras/index.js';
import { api, beaconOnce } from './api.js';
```

Replace `fromStatic`:

```js
function fromStatic() {
  const view = publicView(CATALOG, new Date());
  return { eras: view.eras, products: view.products.map(p => ({ ...p, buyable: false })) };
}
```

In `loadCatalog`, replace `state = { ...(await fromStatic()), site, live: false };` with:

```js
    state = { ...fromStatic(), site, live: false };
```

- [ ] **Step 6: Delete the old sources and the one-off script**

```bash
git rm data/eras.json data/products.json tests/fixtures/images-snapshot.json scripts/migrate-era-folders.mjs
```

Run: `grep -rn "eras.json\|products.json\|images-snapshot" --include=*.js --include=*.mjs --include=*.yml . | grep -v node_modules`
Expected: no output.

- [ ] **Step 7: Run the full suite**

Run: `node --test`
Expected: all pass, `# fail 0`.

- [ ] **Step 8: Confirm the Worker still bundles**

Run: `npx wrangler deploy --dry-run --config worker/wrangler.toml --outdir "$(mktemp -d)"`
Expected: exits 0, no `Could not resolve` errors.

- [ ] **Step 9: Commit**

```bash
git add -A tests/data.test.mjs worker/src/lib/catalog.js assets/js/store.js
git commit -m "Read the catalog from era folders and enforce the folder rules"
```

---

### Task 4: `npm run new-era` scaffold

**Files:**
- Create: `scripts/new-era.mjs`
- Create: `data/eras/shared.js`
- Modify: `package.json` (`scripts`)
- Modify: `tests/data.test.mjs` (add the TODO check)
- Test: `tests/new-era.test.mjs`

**Interfaces:**
- Consumes: `data/eras/index.js` markers `// eras:imports` and `// eras:list`; identifier rule `era_<slug with - → _>` (Task 2).
- Produces:
  - `newEra({ root: URL, slug: string, name: string }) => void` — `root` is a file URL of the eras directory with a trailing slash. Throws `Error` with a user-readable message and writes nothing on any failure.
  - `template(slug, name) => string`, `ident(slug) => string`.
  - `data/eras/shared.js` exporting `SIZES` (frozen `['S', 'M', 'L', 'XL', '2XL']`).

- [ ] **Step 1: Write the failing tests**

`tests/new-era.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { newEra } from '../scripts/new-era.mjs';

const INDEX = `// Era order, newest first.
import { merge } from './merge.js';
// eras:imports
import * as era_core from './core/era.js';

const ERAS = [
  // eras:list
  era_core,
];
`;

function setup(index = INDEX) {
  const dir = mkdtempSync(join(tmpdir(), 'eras-'));
  writeFileSync(join(dir, 'index.js'), index);
  writeFileSync(join(dir, 'shared.js'), "export const SIZES = ['S'];\n");
  mkdirSync(join(dir, 'core'));
  return { dir, root: pathToFileURL(dir + '/') };
}

const state = dir => JSON.stringify(readdirSync(dir, { recursive: true }).sort()) + readFileSync(join(dir, 'index.js'), 'utf8');

test('creates the folder, the template and index entries above the existing eras', async () => {
  const { dir, root } = setup();
  newEra({ root, slug: 'summer-26', name: `Rock 'n' "Roll"` });

  assert.ok(existsSync(join(dir, 'summer-26', 'img')));
  const index = readFileSync(join(dir, 'index.js'), 'utf8');
  const imp = "import * as era_summer_26 from './summer-26/era.js';";
  assert.ok(index.includes(imp));
  assert.ok(index.indexOf(imp) < index.indexOf('import * as era_core'));
  assert.ok(index.indexOf('  era_summer_26,') > index.indexOf('// eras:list'));
  assert.ok(index.indexOf('  era_summer_26,') < index.indexOf('  era_core,'));

  const mod = await import(pathToFileURL(join(dir, 'summer-26', 'era.js')).href);
  assert.equal(mod.era.slug, 'summer-26');
  assert.equal(mod.era.name, `Rock 'n' "Roll"`);
  assert.equal(mod.era.hero, 'hero.jpg');
  assert.equal(mod.era.dropsAt, null);
  assert.deepEqual(mod.products, []);
  assert.match(readFileSync(join(dir, 'summer-26', 'era.js'), 'utf8'), /TODO/);
});

test('keeps CRLF line endings in index.js', () => {
  const { dir, root } = setup(INDEX.replace(/\n/g, '\r\n'));
  newEra({ root, slug: 'drop-two', name: 'Drop Two' });
  const index = readFileSync(join(dir, 'index.js'), 'utf8');
  assert.equal(index.replace(/\r\n/g, '').includes('\n'), false);
});

for (const [label, args] of [
  ['empty slug', { slug: '', name: 'X' }],
  ['missing slug', { name: 'X' }],
  ['uppercase slug', { slug: 'Summer', name: 'X' }],
  ['underscore slug', { slug: 'summer_26', name: 'X' }],
  ['leading dash', { slug: '-x', name: 'X' }],
  ['trailing dash', { slug: 'x-', name: 'X' }],
  ['path in slug', { slug: '../x', name: 'X' }],
  ['missing name', { slug: 'x' }],
  ['blank name', { slug: 'x', name: '   ' }],
  ['duplicate slug', { slug: 'core', name: 'Core' }],
]) {
  test(`rejects ${label} and changes nothing`, () => {
    const { dir, root } = setup();
    const before = state(dir);
    assert.throws(() => newEra({ root, ...args }), Error);
    assert.equal(state(dir), before);
  });
}

test('rejects an index.js without markers and changes nothing', () => {
  const { dir, root } = setup(INDEX.replace('// eras:list\n', ''));
  const before = state(dir);
  assert.throws(() => newEra({ root, slug: 'x', name: 'X' }), /marker/);
  assert.equal(state(dir), before);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/new-era.test.mjs`
Expected: FAIL with `Cannot find module` … `scripts/new-era.mjs`

- [ ] **Step 3: Write the shared constants**

`data/eras/shared.js`:

```js
// Values several eras reuse. Import what you need in an era.js.
export const SIZES = Object.freeze(['S', 'M', 'L', 'XL', '2XL']);
```

- [ ] **Step 4: Write the scaffold script**

`scripts/new-era.mjs`:

```js
// Scaffolds a new era: `npm run new-era -- <slug> "<Name>"`.
// Creates data/eras/<slug>/era.js and img/, and lists the era first in data/eras/index.js.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const IMPORTS = '// eras:imports';
const LIST = '// eras:list';

export const ident = slug => `era_${slug.replace(/-/g, '_')}`;

export const template = (slug, name) => `import { SIZES } from '../shared.js';

// TODO: write the tagline and story, add img/hero.jpg, set dropsAt, add products.
// npm test fails while any TODO is left in this file.
export const era = {
  slug: '${slug}',
  name: ${JSON.stringify(name)},
  tagline: 'TODO',
  story: 'TODO',
  hero: 'hero.jpg',
  dropsAt: null, // ISO with offset, e.g. '2026-11-20T18:00:00-05:00'. null = live as soon as it ships.
  endsAt: null,
};

// Photos go in ./img with lowercase-kebab names: <product-id>-<n>.jpg or <product-id>-<colour>-<n>.jpg.
// Example product:
// {
//   id: '${slug}-tee',
//   name: '...',
//   category: 'tees',
//   priceCents: 3499,
//   fabric: '...',
//   sizes: SIZES,
//   colors: [{ name: 'Black', hex: '#151515' }],
//   images: ['${slug}-tee-1.jpg'],
//   soldOut: false,
//   soldOutVariants: [],
// },
export const products = [];
`;

export function newEra({ root, slug, name }) {
  if (!slug || !SLUG.test(slug)) throw new Error(`Slug must be lowercase kebab-case, e.g. summer-26 (got "${slug ?? ''}").`);
  if (!name || !name.trim()) throw new Error('Name is required: npm run new-era -- summer-26 "Summer 26"');
  const dir = new URL(`${slug}/`, root);
  if (existsSync(dir)) throw new Error(`data/eras/${slug} already exists.`);

  const indexUrl = new URL('index.js', root);
  const index = readFileSync(indexUrl, 'utf8');
  const eol = index.includes('\r\n') ? '\r\n' : '\n';
  const lines = index.split(eol);
  const at = marker => lines.findIndex(l => l.trim() === marker);
  if (at(IMPORTS) < 0 || at(LIST) < 0) throw new Error(`data/eras/index.js is missing the "${IMPORTS}" or "${LIST}" marker.`);

  lines.splice(at(LIST) + 1, 0, `  ${ident(slug)},`); // LIST is below IMPORTS, so insert it first
  lines.splice(at(IMPORTS) + 1, 0, `import * as ${ident(slug)} from './${slug}/era.js';`);

  mkdirSync(new URL('img/', dir), { recursive: true });
  writeFileSync(new URL('era.js', dir), template(slug, name.trim()));
  writeFileSync(indexUrl, lines.join(eol));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [slug, name] = process.argv.slice(2);
  try {
    newEra({ root: new URL('../data/eras/', import.meta.url), slug, name });
    console.log(`Created data/eras/${slug}/
Next:
  1. Add photos to data/eras/${slug}/img/ (hero.jpg plus product shots, max 500 KB each)
  2. Fill in data/eras/${slug}/era.js and remove every TODO
  3. Set dropsAt for a scheduled drop
  4. npm test, then push to main`);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test tests/new-era.test.mjs`
Expected: PASS (13 tests).

- [ ] **Step 6: Add the npm script**

In `package.json` `scripts`, after `"test": "node --test",` add:

```json
    "new-era": "node scripts/new-era.mjs",
```

- [ ] **Step 7: Add the TODO check to the data test**

In `tests/data.test.mjs`, after the `'each era.js declares the slug of its folder'` test, add:

```js
test('no era.js has a TODO left', () => {
  for (const dir of dirs) {
    const text = readFileSync(new URL(`${dir}/era.js`, erasDir), 'utf8');
    assert.ok(!text.includes('TODO'), `data/eras/${dir}/era.js still has a TODO`);
  }
});
```

Run: `node --test`
Expected: all pass.

- [ ] **Step 8: Prove an unfinished scaffold cannot ship**

```bash
npm run new-era -- test-era "Test Era"
node --test tests/data.test.mjs
```
Expected: the scaffold prints the next steps; the data test FAILS on `no era.js has a TODO left` and on `data/eras/test-era/img/hero.jpg is missing`.

Then undo:
```bash
rm -rf data/eras/test-era && git checkout data/eras/index.js && git status --short data/eras
```
Expected: `git status` shows nothing for `data/eras`.

- [ ] **Step 9: Commit**

```bash
git add scripts/new-era.mjs data/eras/shared.js package.json tests/new-era.test.mjs tests/data.test.mjs
git commit -m "Add npm run new-era scaffold"
```

---

### Task 5: README and end-to-end check

**Files:**
- Modify: `README.md` (Layout bullet for `data/`, the whole `## Catalog changes` section)

**Interfaces:**
- Consumes: everything above.
- Produces: docs only.

- [ ] **Step 1: Update the Layout bullet**

Replace the line starting ``- `data/eras.json`, `data/products.json`, `data/site.json`: the catalog.`` with:

```markdown
- `data/eras/<slug>/`: one folder per era. `era.js` holds the era and its products; `img/` holds that era's photos.
  `data/eras/index.js` sets the order (newest first). `data/site.json` holds site copy.
- `assets/img/`: every photo that doesn't belong to an era (logo, favicon, `site/` lookbook and banners).
```

- [ ] **Step 2: Replace the `## Catalog changes` section**

Replace everything from `## Catalog changes` up to (not including) `## Tests` with:

````markdown
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
| Sold out | `soldOut: true` for a whole product, or `soldOutVariants: ['Black|XL']` for one colour and size |
| Replace a stand-in photo | Overwrite the file in `img/` with the same name |

Then `npm test` and push to `main`. Tests check folder names, photos and data before anything deploys.
If the repo is public, an unreleased era's folder is readable on GitHub before the drop.
````

- [ ] **Step 3: Run the full suite**

Run: `node --test`
Expected: all pass, `# fail 0`.

- [ ] **Step 4: Manual check with the API up (375 px first)**

Run in two background shells: `npm run dev:api` and `npx http-server -p 5180 -c-1 .` (with `assets/js/config.js` pointing `API_BASE` at `http://localhost:8787`).
With Playwright at 375×812, open `http://localhost:5180/`, then check:
- hero, lookbook and banner images load from `assets/img/site/`
- each era section and product tile image loads from `data/eras/<slug>/img/`
- product view: switching colour swaps to that colour's photos (e.g. Disaster Zone Tee)
- add an item to the bag: the bag line image loads
- browser console and network: no 404s
Repeat at 1280 px.

- [ ] **Step 5: Manual check with the API down**

Stop `npm run dev:api`, reload at 375 px. Expected: the store renders from the bundled catalog, the same local photos load, products show as not buyable, no 404s.

- [ ] **Step 6: Commit**

```bash
git add README.md
git commit -m "Document the era folder workflow"
```
