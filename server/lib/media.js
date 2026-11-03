import { mkdir, readFile, writeFile, rename, readdir, stat, rm, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { HttpError, readBytes } from './http.js';
import { listAll } from './stock.js';
import { createLogger } from './log.js';
import { WIDTHS, MAX_VARIANT_BYTES, MIN_WIDTH, variantWidths } from '../../data/photos.js';

export const MEDIA_NAME = /^[0-9a-f]{24}-[0-9]{3,4}\.(webp|jpg)$/;

const ascii = (b, at, s) => [...s].every((c, i) => b[at + i] === c.charCodeAt(0));

// Reads type and pixel size from the header alone; null for anything that is not WebP or JPEG.
export function sniffImage(b) {
  if (b.length > 30 && ascii(b, 0, 'RIFF') && ascii(b, 8, 'WEBP')) {
    const u16 = i => b[i] | (b[i + 1] << 8);
    if (ascii(b, 12, 'VP8 ') && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) return { ext: 'webp', width: u16(26) & 0x3fff, height: u16(28) & 0x3fff };
    if (ascii(b, 12, 'VP8L') && b[20] === 0x2f) {
      const bits = (b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24)) >>> 0;
      return { ext: 'webp', width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    if (ascii(b, 12, 'VP8X')) return { ext: 'webp', width: (b[24] | (b[25] << 8) | (b[26] << 16)) + 1, height: (b[27] | (b[28] << 8) | (b[29] << 16)) + 1 };
    return null;
  }
  if (b[0] !== 0xff || b[1] !== 0xd8) return null;
  for (let i = 2; i + 9 < b.length;) {
    if (b[i] !== 0xff) return null;
    const m = b[i + 1];
    if (m === 0xff) { i++; continue; }
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { ext: 'jpg', height: (b[i + 5] << 8) | b[i + 6], width: (b[i + 7] << 8) | b[i + 8] };
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
    i += 2 + ((b[i + 2] << 8) | b[i + 3]);
  }
  return null;
}

const checked = name => {
  if (!MEDIA_NAME.test(name)) throw new Error(`Bad media name: ${name}`);
  return name;
};

// Photos on a disk directory. Names are content hashes, so a write never replaces anything.
export function mediaStore(dir) {
  const path = name => join(dir, checked(name));
  const missing = e => { if (e.code !== 'ENOENT') throw e; };
  return {
    async read(name) {
      try { return new Uint8Array(await readFile(path(name))); } catch (e) { missing(e); return null; }
    },
    async has(name) {
      try { await stat(path(name)); return true; } catch (e) { missing(e); return false; }
    },
    async write(name, bytes) {
      const file = path(name);
      if (await this.has(name)) { const t = new Date(); await utimes(file, t, t); return; } // re-upload keeps cleanup away
      await mkdir(dir, { recursive: true });
      const tmp = `${file}.${crypto.randomUUID()}.tmp`;
      await writeFile(tmp, bytes);
      await rename(tmp, file);
    },
    async list() {
      let names;
      try { names = await readdir(dir); } catch (e) { missing(e); return []; }
      const out = [];
      for (const name of names.filter(n => MEDIA_NAME.test(n))) { const st = await stat(join(dir, name)); out.push({ name, mtimeMs: st.mtimeMs, size: st.size }); }
      return out;
    },
    async remove(name) { await rm(path(name), { force: true }); },
  };
}

// Validates one photo's variant files, stores them under content names, returns the photo ref.
export async function storePhoto(media, files) {
  const bad = () => new HttpError('invalid-photo', 400);
  const infos = files.map(sniffImage);
  if (!infos.length || infos.some(i => !i || i.width < MIN_WIDTH || i.height < 1)) throw bad();
  const { ext } = infos[0];
  const widest = infos.reduce((a, b) => (b.width > a.width ? b : a));
  const ratio = widest.height / widest.width;
  if (infos.some(i => i.ext !== ext || i.width > WIDTHS.at(-1) || Math.abs(i.height / i.width - ratio) > ratio * 0.01)) throw bad();
  if (files.some(f => f.length > MAX_VARIANT_BYTES)) throw bad();
  const widths = infos.map(i => i.width).sort((a, b) => a - b);
  const want = variantWidths(widest.width);
  if (widths.length !== want.length || widths.some((w, i) => w !== want[i])) throw bad();
  const hash = await crypto.subtle.digest('SHA-256', files[infos.indexOf(widest)]);
  const id = [...new Uint8Array(hash).slice(0, 12)].map(x => x.toString(16).padStart(2, '0')).join('');
  for (const [i, f] of files.entries()) await media.write(`${id}-${infos[i].width}.${ext}`, f);
  return { id, width: widest.width, height: widest.height, widths, ext };
}

const MAX_UPLOAD = 1024 * 1024;

// Stores the `file` parts of a multipart body as one photo; 400 invalid-photo for anything else. Photos share the
// disk with the order database, so a low disk refuses them before the body is read.
export async function uploadPhoto(req, env) {
  if (env.OPERATIONS?.().disk === 'low') throw new HttpError('disk-full', 507);
  const media = env.MEDIA;
  const type = req.headers.get('content-type') ?? '';
  const bytes = await readBytes(req, MAX_UPLOAD);
  let form;
  try {
    if (!type.startsWith('multipart/form-data')) throw new Error('not multipart');
    form = await new Request(req.url, { method: 'POST', headers: { 'content-type': type }, body: bytes }).formData();
  } catch { throw new HttpError('invalid-photo', 400); }
  const parts = form.getAll('file').filter(v => typeof v !== 'string');
  return storePhoto(media, await Promise.all(parts.map(async f => new Uint8Array(await f.arrayBuffer()))));
}

const DAY = 24 * 3600 * 1000;

// Deletes media files over 24 h old that no era or product references, whatever its status. A doc it can't read
// means keep everything this run.
export async function cleanMedia(env, now, log = createLogger({ route: 'media-gc' })) {
  const keep = new Set();
  try {
    for (const prefix of ['era:', 'product:']) {
      for (const { name } of await listAll(env.ORDERS, prefix)) {
        const doc = await env.ORDERS.get(name, 'json');
        if (doc === null) continue; // deleted since the listing
        if (typeof doc !== 'object' || Array.isArray(doc)) throw new Error(`unreadable ${name}`);
        const refs = [doc.hero, ...(doc.images ?? []), ...(doc.colors ?? []).flatMap(c => c.images ?? [])].filter(Boolean);
        for (const r of refs) for (const w of r.widths) keep.add(`${r.id}-${w}.${r.ext}`);
      }
    }
  } catch (err) {
    log.warn('media.gc_skipped', { message: String(err?.message ?? err) });
    return 0;
  }
  let removed = 0;
  for (const { name, mtimeMs } of await env.MEDIA.list()) {
    if (keep.has(name) || +now - mtimeMs <= DAY) continue;
    await env.MEDIA.remove(name);
    removed++;
  }
  if (removed) log.info('media.cleaned', { removed });
  return removed;
}
