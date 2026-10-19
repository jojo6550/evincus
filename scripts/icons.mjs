// Rebuild the browser and home-screen icons from the current brand logo.
import sharp from 'sharp';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const directory = new URL('../assets/img/', import.meta.url);
const { data, info } = await sharp(fileURLToPath(new URL('logo.png', directory))).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
let left = info.width, top = info.height, right = -1, bottom = -1;
for (let y = 0; y < info.height; y++) {
  for (let x = 0; x < info.width; x++) {
    if (data[(y * info.width + x) * info.channels + info.channels - 1] <= 10) continue;
    left = Math.min(left, x); top = Math.min(top, y);
    right = Math.max(right, x); bottom = Math.max(bottom, y);
  }
}
if (right < left) throw new Error('The logo is fully transparent');
const logo = await sharp(data, { raw: info }).extract({ left, top, width: right - left + 1, height: bottom - top + 1 }).png().toBuffer();
const icon = async size => {
  const padding = Math.max(1, Math.round(size * 0.06));
  return sharp(logo).resize(size - padding * 2, size - padding * 2, { fit: 'contain', background: '#00000000' })
    .extend({ top: padding, bottom: padding, left: padding, right: padding, background: '#00000000' }).png().toBuffer();
};

const sizes = [16, 32, 48, 64, 128, 256];
const frames = await Promise.all(sizes.map(icon));
const header = Buffer.alloc(6 + sizes.length * 16);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(sizes.length, 4);
let offset = header.length;
for (let i = 0; i < sizes.length; i++) {
  const entry = 6 + i * 16;
  header[entry] = header[entry + 1] = sizes[i] === 256 ? 0 : sizes[i];
  header.writeUInt16LE(1, entry + 4);
  header.writeUInt16LE(32, entry + 6);
  header.writeUInt32LE(frames[i].length, entry + 8);
  header.writeUInt32LE(offset, entry + 12);
  offset += frames[i].length;
}
const favicon = Buffer.concat([header, ...frames]);
await writeFile(new URL('favicon.ico', directory), favicon);
await writeFile(new URL('apple-touch-icon.png', directory), await icon(180));

// A content version makes browsers request the new artwork after a logo update.
const version = createHash('sha256').update(favicon).digest('hex').slice(0, 12);
const root = new URL('../', import.meta.url);
for (const filename of await readdir(root)) {
  if (!filename.endsWith('.html')) continue;
  const file = new URL(filename, root);
  const html = await readFile(file, 'utf8');
  const updated = html.replace(/assets\/img\/(favicon\.ico|apple-touch-icon\.png)(?:\?v=[a-f0-9]+)?(?=")/g,
    (_, name) => `assets/img/${name}?v=${version}`);
  if (updated !== html) await writeFile(file, updated);
}
