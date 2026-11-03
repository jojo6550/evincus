// Uploads photos to the store: `npm run photos -- <era> <product-id> [--color "<Colour name>"] <photo...> [local] [url=<base>]`
// or `npm run photos -- <era> hero <photo>`. Each photo becomes upright WebP copies at the standard widths (EXIF/GPS
// stripped), each under 250 KiB, uploaded to the server and attached to the product, colour or era hero.
import { existsSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { variantWidths, MAX_VARIANT_BYTES } from '../data/photos.js';
import { parseOptions, apiBase, adminToken, adminFetch, problem } from './lib/admin-cli.mjs';

export const USAGE = `Usage:
  npm run photos -- <era> <product-id> [--color "<Colour name>"] <photo...> [local] [url=<base>]
  npm run photos -- <era> hero <photo> [local] [url=<base>]
  PowerShell drops the --, so write color="<Colour name>" instead of --color.`;

// One WebP per standard width of the upright photo. sharp drops metadata unless asked to keep it.
export async function photoVariants(path) {
  const upright = await sharp(path).rotate().toBuffer({ resolveWithObject: true });
  const out = [];
  for (const width of variantWidths(upright.info.width)) {
    let buf;
    for (let quality = 82; quality >= 50; quality -= 8) {
      buf = await sharp(upright.data).resize({ width }).webp({ quality }).toBuffer();
      if (buf.length <= MAX_VARIANT_BYTES) break;
    }
    if (buf.length > MAX_VARIANT_BYTES) throw new Error(`${basename(path)} won't fit under ${MAX_VARIANT_BYTES / 1024} KiB at ${width} px.`);
    out.push(buf);
  }
  return out;
}

const REASONS = {
  'unknown-era': ({ era }) => `The store has no era "${era}".`,
  'unknown-product': ({ era, target }) => `${era} has no product "${target}".`,
  'invalid-photo': ({ file }) => file ? `${file} was rejected by the server as an image.` : "The server refused those photos or the era/colour combination (hero takes one photo and no --color; a product with per-colour photos needs --color with an exact colour name).",
};

async function fail(res, ctx) {
  let code;
  try { code = (await res.clone().json())?.error?.code; } catch { /* not JSON */ }
  throw new Error(REASONS[code]?.(ctx) ?? await problem(res));
}

export async function addPhotos({ base, token, era, target, color, photos, fetchFn = fetch, log = console.log }) {
  if (!era) throw new Error('Name an era.');
  if (!target) throw new Error('Name a product id, or "hero".');
  if (!photos.length) throw new Error('No photos given.');
  if (target === 'hero' && (photos.length !== 1 || color)) throw new Error('hero takes exactly one photo and no --color.');
  for (const p of photos) if (!existsSync(p)) throw new Error(`${p} doesn't exist.`);

  const converted = [];
  for (const p of photos) converted.push(await photoVariants(p)); // convert everything first: a bad photo must not orphan uploads
  const refs = [];
  for (const [i, bufs] of converted.entries()) {
    const form = new FormData();
    for (const buf of bufs) form.append('file', new Blob([buf], { type: 'image/webp' }), 'photo.webp');
    const res = await adminFetch(base, token, '/api/admin/media', { method: 'PUT', body: form }, fetchFn);
    if (!res.ok) await fail(res, { era, target, file: basename(photos[i]) });
    refs.push(await res.json());
  }
  const res = await adminFetch(base, token, '/api/admin/photos', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ era, target, ...(color && { color }), refs }),
  }, fetchFn);
  if (!res.ok) await fail(res, { era, target });

  const n = refs.length;
  log(target === 'hero'
    ? `Set the hero of ${era}. See it at ${base}/inventory#inventory/eras/${era}`
    : `Added ${n} photo${n === 1 ? '' : 's'} to ${target}${color ? ` / ${color}` : ''}. See it at ${base}/inventory#inventory/${target}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { flags, rest } = parseOptions(process.argv.slice(2), { values: ['color'] });
    const [era, target, ...photos] = rest;
    await addPhotos({ base: apiBase(flags), token: adminToken(), era, target, color: flags.color ?? undefined, photos: photos.map(p => resolve(p)) });
  } catch (err) {
    console.error(err.message);
    console.error(USAGE);
    process.exit(1);
  }
}
