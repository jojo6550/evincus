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
