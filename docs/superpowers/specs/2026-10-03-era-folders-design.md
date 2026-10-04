# Era folders: managing eras, products and stock in the repo — design

Date: 2026-10-03
Status: approved in brainstorming, pending written-spec review

## 1. Goal and constraints

Make adding, retiring, deleting and editing eras, their products and their sold-out flags a matter of editing one folder per era, with photos stored next to the era they belong to.

- Edited by the developer in the repo. Publishing stays `npm test` then push to `main` (CI deploys the Worker and Pages, about 2 minutes).
- No admin UI, no database, no auth. The catalog stays bundled into the Worker at deploy.
- The merged catalog keeps today's shape (`{ eras, products }`), so `data/catalog.js`, pricing, routes and page rendering do not change.

### Decisions made

| Topic | Decision |
|---|---|
| Source of truth | One folder per era under `data/eras/<slug>/`, holding `era.js` (era plus its products) and `img/` |
| Era order | `data/eras/index.js` imports each era, newest first |
| Era photos | Only in `data/eras/<slug>/img/` (hero and product shots) |
| Other photos | In `assets/img/` (logo, favicon, site/lookbook photos) |
| Image references in `era.js` | Bare filenames; `index.js` expands them to site-relative paths |
| Stock | Unchanged: `soldOut` and `soldOutVariants` flags. No counts |
| Scaffolding | `npm run new-era -- <slug> "<Name>"` |
| Current photos | Shopify CDN images are stand-ins. Download them into the repo now; real photos replace them later by overwriting files of the same name |

### Out of scope

Stock counts, admin UI, editing from a phone, image processing beyond the one-off migration.

### Assumption

If the repo is public, unreleased eras in `data/eras/` are readable on GitHub before the drop (same as today). Keep the repo private, or add an era only on drop day.

## 2. Layout

```
data/
  catalog.js              rules (unchanged)
  site.json               site copy; image URLs point at assets/img/site/
  eras/
    index.js              era order + merge → { eras, products }
    shared.js             optional shared constants (SIZES, common colours)
    catastrophe/
      era.js
      img/
    reflection/
      era.js
      img/
    core/
      era.js
      img/
assets/img/
  favicon.ico, logo.png, life0303.jpg
  site/                   non-era photos (lookbook, hero banners used by index.html / site.json)
scripts/
  new-era.mjs
  migrate-era-folders.mjs one-off; deleted after the migration commit
```

`data/eras.json` and `data/products.json` are deleted.

## 3. `era.js` format

```js
import { SIZES } from '../shared.js';

export const era = {
  slug: 'core',
  name: 'Core',
  tagline: 'Always in the line-up',
  story: 'Heavyweight oversized tees that stay in the store between drops.',
  hero: 'hero.jpg',
  dropsAt: null,            // ISO with offset, e.g. '2026-11-20T18:00:00-05:00'
  endsAt: null,
};

export const products = [
  {
    id: 'core-tee',
    name: 'Core Tee',
    category: 'tees',
    priceCents: 3499,
    fabric: 'Oversized fit, 100% cotton, 300 g/m²',
    sizes: SIZES,
    colors: [{ name: 'Black', hex: '#151515', images: ['core-tee-black-1.jpg'] }],
    images: ['core-tee-1.jpg'],
    soldOut: false,
    soldOutVariants: [],    // "<color>|<size>"
  },
];
```

Rules:
- `era.slug` must equal the folder name.
- Products do not declare `era`; `index.js` sets it from the folder.
- `hero`, `images` and `colors[].images` hold bare filenames (no `/`) that exist in that era's `img/`.
- Photo filenames: `<product-id>-<n>.<ext>` or `<product-id>-<colour-slug>-<n>.<ext>`; hero is `hero.<ext>`. Replacing a stand-in means overwriting the file with the same name (or changing the filename in `era.js`).

## 4. `data/eras/index.js`

```js
import * as catastrophe from './catastrophe/era.js';
import * as reflection from './reflection/era.js';
import * as core from './core/era.js';

// Newest first. new-era adds lines at the top.
const ERAS = [catastrophe, reflection, core];

export const FOLDERS = ERAS.map(m => m.era.slug);
export const CATALOG = merge(ERAS);
```

`merge` expands each filename to `data/eras/<slug>/img/<file>` and returns `{ eras, products }` where every product gets `era: <slug>`. It does no validation; the tests do that. The path is site-relative with no leading slash, so it resolves against the site root on Pages under any base path, and the Worker's quote lines return the same string for the bag to render.

## 5. Consumers

| File | Change |
|---|---|
| `worker/src/lib/catalog.js` | Import `CATALOG` from `data/eras/index.js` instead of the two JSON files; `site.json` import stays |
| `assets/js/store.js` | `fromStatic()` uses the imported `CATALOG` instead of fetching `eras.json` / `products.json`. `site.json` fetch stays |
| `tests/data.test.mjs` | Reads from `data/eras/index.js`; adds the checks in section 6 |
| `README.md` | Replace the JSON editing instructions with the workflow in section 8 |

The CI Pages step already copies `data/` and `assets/`, so era photos and `assets/img/site/` ship without workflow changes.

## 6. Validation (`tests/data.test.mjs`)

All current checks (slugs, ids, categories, prices, sizes, colours, sold-out variants, dates), plus:

- Each `data/eras/*/` directory appears in `FOLDERS`, and each `FOLDERS` entry has a directory.
- Each era module's `era.slug` equals its folder name.
- Each image field is a bare filename and the file exists in that era's `img/`.
- No image file is over 500 KB.
- Each product has at least one image for its first colour (existing check).
- No `site.json` image points into `data/eras/` (non-era photos live in `assets/img/`).

The images snapshot test is replaced by a migration check (section 9) and then removed with the fixture.

## 7. `npm run new-era -- <slug> "<Name>"`

`scripts/new-era.mjs`, Node only, no dependencies.

1. Reject a missing or non-kebab-case slug, a missing name, or an existing `data/eras/<slug>/`.
2. Create `data/eras/<slug>/img/` and `data/eras/<slug>/era.js` from a template: given slug and name, empty tagline/story with `TODO` comments, `hero: 'hero.jpg'`, `dropsAt: null`, `endsAt: null`, `products: []`.
3. Insert the import line and the array entry at the top of `index.js`.
4. Print next steps: add photos to `img/`, fill in `era.js`, set `dropsAt`, run `npm test`, push.

`npm test` fails on a fresh scaffold until the hero photo exists and the TODO fields are filled, so an unfinished era cannot ship. A test checks that no `era.js` string contains `TODO`.

## 8. Workflow

| Task | Steps |
|---|---|
| Add an era | `npm run new-era -- <slug> "<Name>"`, add photos, fill in `era.js` |
| Schedule a drop | Set `dropsAt` (and optionally `endsAt`) |
| Retire an era | Set `endsAt`; it archives and old links keep working |
| Delete an era | Delete its folder and its two lines in `index.js` |
| Add / edit / remove a product | Edit that era's `products` array; add or remove its photos |
| Move a product between eras | Move its object and its photos to the other folder |
| Mark sold out | `soldOut: true`, or add `"Black|2XL"` to `soldOutVariants` |
| Replace a stand-in photo | Overwrite the file in `img/` with the same name |
| Publish | `npm test`, then push to `main` |

## 9. Migration (one-off)

`scripts/migrate-era-folders.mjs`, run once, committed output, script deleted afterwards.

1. For each era in `eras.json`: create the folder, download the hero to `img/hero.<ext>`.
2. For each product: download every image URL (product-level and per-colour) to the era's `img/` with names from section 3. Identical URLs used by several colours are downloaded once and referenced by the same filename.
3. Download at `width=1200`. If the 1200 px PNG has an alpha channel (colour type 4 or 6), keep it as PNG; otherwise request `format=pjpg` and save as `.jpg`. If a file is still over 500 KB, retry at `width=1000`.
4. Download `site.json` and `index.html` remote photos to `assets/img/site/` and rewrite those references to local paths.
5. Write each `era.js` (products in their current order) and `index.js` (eras in their current order).
6. Check before deleting the JSON: for every product and colour, the new `imagesFor()` output maps one-to-one, in order, to the old URLs (via the download map), and every non-image field is deep-equal to the old product. Then delete `eras.json`, `products.json` and the snapshot fixture.

## 10. Testing

- `data.test.mjs`: the section 6 checks, run against the real catalog.
- `new-era.test.mjs`: runs the script against a temp copy of `data/eras/`. Creates the folder and template, inserts at the top of `index.js`, and rejects a bad slug, a missing name and a duplicate slug without changing anything.
- Existing route, pricing and catalog tests pass unchanged against `CATALOG`.
- Manual: `npm run dev:api` plus the static site at 375 px. Era pages, product view, bag line images and the static fallback (API stopped) all show local photos.
