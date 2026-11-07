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
// The artwork is dark ink on light. Every derivative draws it in bone for the near-black brand: ink darkness becomes
// opacity, so strokes are solid bone and the pale ghost letter stays a faint trace instead of a dark smudge.
const BONE = [0xf3, 0xef, 0xe8];
const ink = await sharp(logo).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const lum = i => 0.2126 * ink.data[i] + 0.7152 * ink.data[i + 1] + 0.0722 * ink.data[i + 2];
let darkest = 255;
for (let i = 0; i < ink.data.length; i += 4) if (ink.data[i + 3] > 200) darkest = Math.min(darkest, lum(i));
const bone = Buffer.alloc(ink.data.length);
for (let i = 0; i < ink.data.length; i += 4) {
  bone.set(BONE, i);
  bone[i + 3] = Math.round(ink.data[i + 3] * Math.min(1, (255 - lum(i)) / (255 - darkest)));
}
const light = await sharp(bone, { raw: ink.info }).png().toBuffer();
// Bone mark on an ink tile: tabs and home screens can be dark or light, and iOS fills transparency with black.
const tile = async (size, pad) => {
  const padding = Math.max(1, Math.round(size * pad));
  const mark = await sharp(light).resize(size - padding * 2, size - padding * 2, { fit: 'contain', background: '#00000000' }).png().toBuffer();
  return sharp({ create: { width: size, height: size, channels: 4, background: '#0d0c0f' } }).composite([{ input: mark }]).png().toBuffer();
};

const sizes = [16, 32, 48, 64, 128, 256];
// Tight padding for tabs; home-screen icons get more, since iOS rounds the corners.
const frames = await Promise.all(sizes.map(size => tile(size, 0.06)));
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
await writeFile(new URL('apple-touch-icon.png', directory), await tile(180, 0.14));
// Nav (drawn ~42px wide) and emails (72px) get the cropped mark at full source resolution: sharp on 3x screens.
await sharp(light).webp({ quality: 90, alphaQuality: 90 }).toFile(fileURLToPath(new URL('logo-nav.webp', directory)));
await writeFile(new URL('logo-email.png', directory), await sharp(light).png({ palette: true, colours: 64, compressionLevel: 9 }).toBuffer());

// A content version makes browsers (and mail image proxies, which cache by URL) request the new artwork after a logo update.
const version = createHash('sha256').update(favicon).digest('hex').slice(0, 12);
const root = new URL('../', import.meta.url);
const pages = (await readdir(root)).filter(f => f.endsWith('.html')).map(f => new URL(f, root));
for (const file of [...pages, new URL('server/emails/brand.js', root)]) {
  const html = await readFile(file, 'utf8');
  const updated = html.replace(/assets\/img\/(favicon\.ico|apple-touch-icon\.png|logo-nav\.webp|logo-email\.png)(?:\?v=[a-f0-9]+)?(?=["'])/g,
    (_, name) => `assets/img/${name}?v=${version}`);
  if (updated !== html) await writeFile(file, updated);
}
