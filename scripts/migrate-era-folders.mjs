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
const toJs = v => JSON.stringify(v, null, 2)
  .replace(/^(\s*)"([A-Za-z_$][\w$]*)":/gm, '$1$2:')
  // arrays of plain strings on one line
  .replace(/\[\s+(?:"(?:[^"\\]|\\.)*",?\s*)+\]/g, m => JSON.stringify(JSON.parse(m)).replace(/","/g, '", "'));
const hasAlpha = b => b[0] === 0x89 && b[1] === 0x50 && [4, 6].includes(b[25]); // PNG colour type 4 or 6
const extOf = type => ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' })[type.split(';')[0].trim()];

async function get(url, params, accept) {
  const u = new URL(url);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
  const res = await fetch(u, accept ? { headers: { accept } } : {});
  if (!res.ok) throw new Error(`${u} -> ${res.status}`);
  const type = res.headers.get('content-type') ?? '';
  const ext = extOf(type);
  if (!ext) throw new Error(`${u} -> unexpected content-type "${type}"`);
  return { bytes: Buffer.from(await res.arrayBuffer()), ext };
}

// 1200 px. PNGs with an alpha channel become WebP (keeps transparency; Shopify serves WebP only on Accept),
// everything else progressive JPEG, falling back to WebP when the CDN ignores format=pjpg. Retry smaller if too big.
const webp = (url, width) => get(url, { width }, 'image/webp');
async function download(url) {
  for (const width of [1200, 1000]) {
    const first = await get(url, { width });
    const tries = first.ext === 'png' && hasAlpha(first.bytes)
      ? [() => webp(url, width)]
      : [() => get(url, { width, format: 'pjpg' }), () => webp(url, width)];
    for (const t of tries) {
      const img = await t();
      if (img.ext !== 'png' && img.bytes.length <= MAX) return img;
    }
  }
  throw new Error(`${url} is over 500 KB even at 1000 px`);
}

const eraDir = slug => new URL(`data/eras/${slug}/`, root);
// `${slug} ${owner} ${url}` -> filename. Owner is 'hero' or a product id, so each photo can be replaced on its own.
const saved = new Map();

async function save(slug, owner, url, base) {
  const key = `${slug} ${owner} ${url}`;
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
  const hero = await save(era.slug, 'hero', era.hero, 'hero');
  const out = [];
  for (const p of products.filter(x => x.era === era.slug)) {
    const { era: _era, ...q } = p;
    if (p.images) {
      q.images = [];
      for (const [i, u] of p.images.entries()) q.images.push(await save(era.slug, p.id, u, `${p.id}-${i + 1}`));
    }
    q.colors = [];
    for (const c of p.colors) {
      if (!c.images) { q.colors.push(c); continue; }
      const images = [];
      for (const [i, u] of c.images.entries()) images.push(await save(era.slug, p.id, u, `${p.id}-${slugify(c.name)}-${i + 1}`));
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
const path = (slug, owner, url) => `data/eras/${slug}/img/${saved.get(`${slug} ${owner} ${url}`)}`;
const expected = {
  eras: eras.map(e => ({ ...e, hero: path(e.slug, 'hero', e.hero) })),
  products: eras.flatMap(e => products.filter(p => p.era === e.slug)).map(p => ({
    ...p,
    ...(p.images && { images: p.images.map(u => path(p.era, p.id, u)) }),
    colors: p.colors.map(c => (c.images ? { ...c, images: c.images.map(u => path(p.era, p.id, u)) } : c)),
  })),
};
deepStrictEqual(CATALOG, expected);
deepStrictEqual(CATALOG.products.map(p => p.id), products.map(p => p.id));
console.log(`Verified: ${CATALOG.eras.length} eras, ${CATALOG.products.length} products, ${saved.size} era photos, ${local.size} site photos.`);
