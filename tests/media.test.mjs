import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { MEDIA_NAME, sniffImage, storePhoto, mediaStore } from '../server/lib/media.js';
import { fakeMedia } from './helpers/fake-env.mjs';

const img = (w, h, ext) => {
  const s = sharp({ create: { width: w, height: h, channels: 3, background: '#222' } });
  return (ext === 'webp' ? s.webp() : s.jpeg()).toBuffer();
};
const variants = (w, h, ext, widths = [480, 960, 1200]) => Promise.all(widths.map(x => img(x, Math.round(x * h / w), ext)));
const invalid = p => assert.rejects(p, { code: 'invalid-photo', status: 400 });

test('sniffImage reads WebP and JPEG sizes and rejects other bytes', async () => {
  assert.deepEqual(sniffImage(await img(1200, 1500, 'webp')), { ext: 'webp', width: 1200, height: 1500 });
  assert.deepEqual(sniffImage(await img(960, 1200, 'jpeg')), { ext: 'jpg', width: 960, height: 1200 });
  assert.equal(sniffImage(await sharp({ create: { width: 8, height: 8, channels: 3, background: '#222' } }).png().toBuffer()), null);
  assert.equal(sniffImage(new TextEncoder().encode('GIF89a')), null);
});

test('storePhoto stores a full variant set under content names and is idempotent', async () => {
  const media = fakeMedia();
  const ref = await storePhoto(media, await variants(1200, 1500, 'webp'));
  assert.deepEqual(ref.widths, [480, 960, 1200]);
  assert.match(`${ref.id}-1200.webp`, MEDIA_NAME);
  assert.deepEqual(await storePhoto(media, await variants(1200, 1500, 'webp')), ref);
  assert.equal((await media.list()).length, 3);
});

test('storePhoto refuses mixed types, a missing width, an oversized file, a 1600px file and a wrong aspect ratio', async () => {
  const set = await variants(1200, 1500, 'webp');
  await invalid(storePhoto(fakeMedia(), [set[0], set[1], await img(1200, 1500, 'jpeg')]));
  await invalid(storePhoto(fakeMedia(), [set[0], set[2]]));
  const noisy = await sharp(Buffer.alloc(1200 * 1500 * 3).map(() => Math.random() * 256), { raw: { width: 1200, height: 1500, channels: 3 } }).webp({ quality: 100 }).toBuffer();
  await invalid(storePhoto(fakeMedia(), [set[0], set[1], noisy]));
  await invalid(storePhoto(fakeMedia(), await variants(1600, 2000, 'webp', [480, 960, 1440, 1600])));
  await invalid(storePhoto(fakeMedia(), [set[0], set[1], await img(1200, 1000, 'webp')]));
  await invalid(storePhoto(fakeMedia(), []));
  await invalid(storePhoto(fakeMedia(), [new Uint8Array(10)]));
});

test('storePhoto refuses a photo under 100 px wide or 0 px high with invalid-photo, never a 500', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'media-'));
  try {
    for (const media of [fakeMedia(), mediaStore(dir)]) {
      await invalid(storePhoto(media, [await img(80, 100, 'webp')]));
      const flat = new Uint8Array(await img(480, 600, 'jpeg'));
      const sof = flat.findIndex((b, i) => b === 0xff && flat[i + 1] === 0xc0);
      flat[sof + 5] = 0; flat[sof + 6] = 0; // SOF0 height 0 (a DNL-style header)
      assert.equal(sniffImage(flat).height, 0);
      await invalid(storePhoto(media, [flat]));
    }
    assert.ok((await storePhoto(fakeMedia(), [await img(100, 125, 'webp')])).id);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('mediaStore refuses names outside MEDIA_NAME, including traversal', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'media-'));
  try {
    const store = mediaStore(join(dir, 'nested'));
    for (const name of ['../x', 'a.webp', `${'a'.repeat(24)}-1200.png`]) {
      await assert.rejects(store.read(name));
      await assert.rejects(store.write(name, new Uint8Array(1)));
      await assert.rejects(store.has(name));
      await assert.rejects(store.remove(name));
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('mediaStore writes once, lists, reads and removes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'media-'));
  try {
    const store = mediaStore(join(dir, 'nested'));
    const name = `${'a'.repeat(24)}-480.webp`;
    assert.equal(await store.read(name), null);
    assert.deepEqual(await store.list(), []);
    await store.write(name, new Uint8Array([1, 2]));
    await store.write(name, new Uint8Array([9]));
    assert.deepEqual([...await store.read(name)], [1, 2]);
    assert.equal(await store.has(name), true);
    const [entry] = await store.list();
    assert.equal(entry.name, name);
    assert.equal(typeof entry.mtimeMs, 'number');
    await store.remove(name);
    await store.remove(name);
    assert.equal(await store.has(name), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
