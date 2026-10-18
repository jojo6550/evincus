// Adds photos to an era: `npm run photos -- <era> <product-id> [--color "<Colour name>"] <photo...>`
// or `npm run photos -- <era> hero <photo>`. Each photo is rotated upright, shrunk to fit 1800 px, saved as webp
// under 500 KB in data/eras/<era>/img/ with the next free kebab name, and added to that product's (or colour's)
// images in era.js. Nothing is written unless every photo converts and era.js updates cleanly.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MAX_BYTES = 500 * 1024;
const ARRAY = /images:\s*\[([^\]]*)\]/g;

export const kebab = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const list = inner => JSON.parse(`[${inner.replace(/'/g, '"').replace(/,\s*$/, '')}]`);
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

// Next free <base>-<n> in the folder, counting any extension.
export function nextNames(existing, base, count) {
  const taken = existing.map(f => new RegExp(`^${esc(base)}-(\\d+)\\.[a-z]+$`).exec(f)?.[1]).filter(Boolean).map(Number);
  const start = Math.max(0, ...taken) + 1;
  return Array.from({ length: count }, (_, i) => `${base}-${start + i}.webp`);
}

// Appends files to the images array that currently holds `current` inside the product's block of era.js source.
// With no such array (current is undefined), inserts one under the line that names the product or colour.
export function addToSource(src, { productId, color, current, files }) {
  const idAt = src.search(new RegExp(`id:\\s*["']${esc(productId)}["']`));
  if (idAt < 0) throw new Error(`era.js has no product "${productId}".`);
  const rest = src.slice(idAt + 1).search(/\bid:\s*["']/);
  const end = rest < 0 ? src.length : idAt + 1 + rest;
  const block = src.slice(idAt, end);

  if (current) {
    const hits = [...block.matchAll(ARRAY)].filter(m => same(list(m[1]), current));
    if (hits.length !== 1) throw new Error(`Couldn't find one images list for ${productId}${color ? ` / ${color}` : ''} in era.js; add the files by hand.`);
    const m = hits[0];
    const at = idAt + m.index;
    return src.slice(0, at) + `images: ${JSON.stringify([...current, ...files]).replace(/","/g, '", "')}` + src.slice(at + m[0].length);
  }
  const anchor = color ? new RegExp(`^([ \\t]*)name:\\s*["']${esc(color)}["'],?[^\\n]*\\n`, 'm') : /^([ \t]*)id:[^\n]*\n/m;
  const m = anchor.exec(block);
  if (!m) throw new Error(`Couldn't find where to add images for ${productId}${color ? ` / ${color}` : ''} in era.js; add the files by hand.`);
  const at = idAt + m.index + m[0].length;
  return src.slice(0, at) + `${m[1]}images: ${JSON.stringify(files).replace(/","/g, '", "')},\n` + src.slice(at);
}

// Re-encodes until it fits: lower quality first, then a smaller size.
export async function toWebp(input) {
  const { default: sharp } = await import('sharp');
  for (const size of [1800, 1400, 1000]) {
    for (let quality = 82; quality >= 50; quality -= 8) {
      const out = await sharp(input).rotate().resize({ width: size, height: size, fit: 'inside', withoutEnlargement: true })
        .webp({ quality }).toBuffer();
      if (out.length <= MAX_BYTES) return out;
    }
  }
  throw new Error(`${input} won't fit under 500 KB.`);
}

export async function addPhotos({ root, era, target, color, photos }) {
  const dir = new URL(`${era}/`, root);
  if (!era || !existsSync(new URL('era.js', dir))) throw new Error(`No era "${era ?? ''}" in data/eras/.`);
  if (!target) throw new Error('Name a product id, or "hero".');
  if (!photos.length) throw new Error('No photos given.');
  for (const p of photos) if (!existsSync(p)) throw new Error(`${p} doesn't exist.`);

  const eraUrl = new URL('era.js', dir);
  const src = readFileSync(eraUrl, 'utf8');
  const mod = await import(`${eraUrl.href}?t=${Date.now()}`);
  const imgDir = new URL('img/', dir);
  const existing = existsSync(imgDir) ? readdirSync(imgDir) : [];
  let names, next;

  if (target === 'hero') {
    if (photos.length !== 1 || color) throw new Error('hero takes exactly one photo and no --color.');
    names = ['hero.webp'];
    next = src.replace(/hero:\s*(["'])[^"']*\1/, 'hero: "hero.webp"');
  } else {
    const product = mod.products.find(p => p.id === target);
    if (!product) throw new Error(`${era} has no product "${target}". Products: ${mod.products.map(p => p.id).join(', ')}`);
    const c = color && product.colors.find(c => c.name.toLowerCase() === color.toLowerCase());
    if (color && !c) throw new Error(`${target} has no colour "${color}". Colours: ${product.colors.map(c => c.name).join(', ')}`);
    if (!c && product.colors.some(c => c.images)) throw new Error(`${target} has photos per colour; pass --color "<name>".`);
    names = nextNames(existing, c ? `${target}-${kebab(c.name)}` : target, photos.length);
    next = addToSource(src, { productId: target, color: c?.name, current: c ? c.images : product.images, files: names });
  }

  const buffers = await Promise.all(photos.map(toWebp));
  buffers.forEach((buf, i) => writeFileSync(new URL(names[i], imgDir), buf));
  writeFileSync(eraUrl, next);
  return names.map((n, i) => ({ name: n, kb: Math.round(buffers[i].length / 1024) }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const ci = args.indexOf('--color');
  const color = ci >= 0 ? args.splice(ci, 2)[1] : undefined;
  const [era, target, ...photos] = args;
  try {
    const root = new URL('../data/eras/', import.meta.url);
    const added = await addPhotos({ root, era, target, color, photos: photos.map(p => resolve(p)) });
    for (const a of added) console.log(`  data/eras/${era}/img/${a.name}  ${a.kb} KB`);
    const oldHero = target === 'hero' && readdirSync(new URL(`${era}/img/`, root)).find(f => /^hero\./.test(f) && f !== 'hero.webp');
    if (oldHero) console.log(`data/eras/${era}/img/${oldHero} is no longer used; delete it if you don't need it.`);
    console.log('Updated era.js. Check it with npm run dev, then npm test.');
  } catch (err) {
    console.error(err.message);
    console.error('Usage: npm run photos -- <era> <product-id> [--color "<Colour name>"] <photo...>\n       npm run photos -- <era> hero <photo>');
    process.exit(1);
  }
}
