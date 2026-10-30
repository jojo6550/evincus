import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { parseOptions } from '../scripts/lib/admin-cli.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { photoVariants, addPhotos } from '../scripts/photos.mjs';
import { MAX_VARIANT_BYTES } from '../data/photos.js';

// 3000x2000 landscape stored with EXIF orientation 6 (shows as 2000x3000) and a GPS-bearing EXIF block.
async function exifJpeg() {
  const path = join(mkdtempSync(join(tmpdir(), 'photos-')), 'a.jpg');
  await sharp({ create: { width: 3000, height: 2000, channels: 3, background: '#a33' } })
    .withExif({ IFD3: { GPSLatitudeRef: 'N' } }).withMetadata({ orientation: 6 }).jpeg().toFile(path);
  return path;
}

test('photoVariants makes the standard widths under 250 KiB, upright, without EXIF', async () => {
  const path = await exifJpeg();
  assert.equal((await sharp(path).metadata()).orientation, 6);
  const bufs = await photoVariants(path);
  const metas = await Promise.all(bufs.map(b => sharp(b).metadata()));
  assert.deepEqual(metas.map(m => m.width), [480, 960, 1440]);
  for (const [i, m] of metas.entries()) {
    assert.equal(m.format, 'webp');
    assert.ok(m.height > m.width, 'upright');
    assert.equal(m.exif, undefined);
    assert.ok(bufs[i].length <= MAX_VARIANT_BYTES);
  }
});

const json = (status, body) => new Response(JSON.stringify(body), { status });
const ref = c => ({ id: c.repeat(24), width: 1440, height: 2160, widths: [480, 960, 1440], ext: 'webp' });

test('addPhotos uploads then attaches with the token', async () => {
  const path = await exifJpeg();
  const calls = [];
  const replies = [json(200, ref('a')), json(200, ref('b')), json(200, { product: {}, version: 'v' })];
  const fetchFn = async (url, init) => { calls.push({ url, init }); return replies.shift(); };
  const out = [];
  await addPhotos({ base: 'http://localhost:8000', token: 'tok', era: 'core', target: 'tee', color: 'Black', photos: [path, path], fetchFn, log: l => out.push(l) });
  assert.equal(calls.length, 3);
  for (const c of calls) assert.equal(c.init.headers.Authorization, 'Bearer tok');
  assert.equal(calls[0].url, 'http://localhost:8000/api/admin/media');
  assert.equal(calls[0].init.method, 'PUT');
  assert.equal(calls[0].init.body.getAll('file').length, 3);
  assert.equal(calls[2].url, 'http://localhost:8000/api/admin/photos');
  const body = JSON.parse(calls[2].init.body);
  assert.deepEqual([body.era, body.target, body.color], ['core', 'tee', 'Black']);
  assert.deepEqual(body.refs.map(r => r.id[0]), ['a', 'b']);
  assert.match(out.join('\n'), /2 photos.*tee.*Black/);
  assert.match(out.join('\n'), /localhost:8000\/inventory#inventory\/tee/);
});

test('addPhotos reports the server\'s reason when attaching fails', async () => {
  const path = await exifJpeg();
  const replies = [json(200, ref('a')), json(404, { error: { code: 'unknown-product', message: 'x' } })];
  await assert.rejects(addPhotos({ base: 'http://x', token: 't', era: 'core', target: 'nope', photos: [path], fetchFn: async () => replies.shift(), log() {} }), /core has no product "nope"/);
});

test('photoVariants names the file when it will not fit under 250 KiB', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'photos-')), 'noise.jpg');
  const raw = Buffer.alloc(1600 * 1600 * 3);
  for (let i = 0; i < raw.length; i++) raw[i] = (i * 2654435761 >>> 13) & 255;
  await sharp(raw, { raw: { width: 1600, height: 1600, channels: 3 } }).jpeg({ quality: 100 }).toFile(path);
  await assert.rejects(photoVariants(path), /noise\.jpg won't fit under 250 KiB/);
});

test('addPhotos sets a hero with one photo and no colour', async () => {
  const path = await exifJpeg();
  const calls = [];
  const replies = [json(200, ref('a')), json(200, { era: {}, version: 'v' })];
  const out = [];
  await addPhotos({ base: 'http://x', token: 't', era: 'core', target: 'hero', photos: [path], fetchFn: async (u, i) => { calls.push({ u, i }); return replies.shift(); }, log: l => out.push(l) });
  const body = JSON.parse(calls[1].i.body);
  assert.deepEqual([body.target, body.color, body.refs.length], ['hero', undefined, 1]);
  assert.match(out[0], /hero of core.*#inventory\/eras\/core/);
  await assert.rejects(addPhotos({ base: 'http://x', token: 't', era: 'core', target: 'hero', color: 'Black', photos: [path], fetchFn: async () => {}, log() {} }), /hero takes/);
});

test('a rejected upload names the file and nothing is attached', async () => {
  const path = await exifJpeg();
  const calls = [];
  const fetchFn = async u => { calls.push(u); return json(400, { error: { code: 'invalid-photo', message: 'x' } }); };
  await assert.rejects(addPhotos({ base: 'http://x', token: 't', era: 'core', target: 'tee', photos: [path], fetchFn, log() {} }), /a\.jpg was rejected by the server as an image/);
  assert.equal(calls.length, 1);
});

test('a photo that cannot convert stops everything before any upload', async () => {
  const path = await exifJpeg();
  const bad = join(mkdtempSync(join(tmpdir(), 'photos-')), 'bad.jpg');
  writeFileSync(bad, 'not an image');
  const calls = [];
  await assert.rejects(addPhotos({ base: 'http://x', token: 't', era: 'core', target: 'tee', photos: [path, bad], fetchFn: async u => { calls.push(u); }, log() {} }));
  assert.equal(calls.length, 0);
});

test('color= works as a plain word for npm on PowerShell', () => {
  const { flags, rest } = parseOptions(['core', 'tee', 'color=Black, red', 'a.jpg', 'local'], { values: ['color'] });
  assert.equal(flags.color, 'Black, red');
  assert.deepEqual(rest, ['core', 'tee', 'a.jpg']);
});
