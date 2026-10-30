import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeVariants, photoList, setPhotos, moveTo, removeAt } from '../assets/js/inventory-photos.js';
import { moveSlug, eraStatus } from '../assets/js/inventory-eras.js';
import { MAX_VARIANT_BYTES } from '../data/photos.js';

// A fake canvas whose blob size is width x quality x k; `webp: false` mimics Safari answering with PNG.
const fakes = ({ width = 3000, height = 2000, k = 0.1, webp = true, decode = true } = {}) => {
  const log = [];
  return {
    log,
    createImageBitmap: async (file, opts) => {
      log.push(['decode', opts]);
      if (!decode) throw new Error('nope');
      return { width, height, close() { log.push(['close']); } };
    },
    makeCanvas: (w, h) => ({
      draw() {},
      async blob(type, quality) {
        log.push(['blob', w, h, type, quality]);
        const t = type === 'image/webp' && !webp ? 'image/png' : type;
        return { type: t, size: Math.round(w * quality * k * 1024 * 0.3) };
      },
    }),
  };
};

test('encodeVariants makes one blob per width, all one type, each under 250 KiB', async () => {
  const f = fakes();
  const out = await encodeVariants({}, f);
  assert.equal(out.length, 3);
  assert.ok(out.every(b => b.type === 'image/webp' && b.size <= MAX_VARIANT_BYTES));
  assert.deepEqual(f.log[0], ['decode', { imageOrientation: 'from-image' }]);
  const sizes = f.log.filter(l => l[0] === 'blob').map(l => [l[1], l[2]]);
  assert.deepEqual(sizes.slice(-3), [[480, 320], [960, 640], [1440, 960]]);
  assert.ok(f.log.some(l => l[0] === 'close'));
});

test('encodeVariants falls back to JPEG for every variant when WebP encoding is unsupported', async () => {
  const out = await encodeVariants({}, fakes({ webp: false }));
  assert.equal(out.length, 3);
  assert.ok(out.every(b => b.type === 'image/jpeg'));
});

test('encodeVariants steps quality down and gives up with photo-too-large', async () => {
  const f = fakes({ k: 3 }); // 1440 wide: ~1.2 MB at 0.82, still over at 0.5
  await assert.rejects(encodeVariants({}, f), e => e.code === 'photo-too-large' && /too large/i.test(e.message));
  const qs = [...new Set(f.log.filter(l => l[0] === 'blob' && l[1] === 480).map(l => l[4]))];
  assert.deepEqual(qs, [0.82, 0.76, 0.7, 0.64, 0.58, 0.52]);
  const ok = await encodeVariants({}, fakes({ k: 0.9 }));
  assert.ok(ok.every(b => b.size <= MAX_VARIANT_BYTES));
});

test('encodeVariants says so when the photo cannot be decoded, and uses the photo width for small photos', async () => {
  await assert.rejects(encodeVariants({}, fakes({ decode: false })), e => e.code === 'photo-unreadable' && e.message === "This photo format can't be read here. Try a JPEG.");
  assert.equal((await encodeVariants({}, fakes({ width: 700, height: 700 }))).length, 2);
});

test('photo list helpers edit a colour, or the all-colours list, without touching others', () => {
  const p = { images: [{ id: 'a' }], colors: [{ name: 'Red' }, { name: 'Blue', images: [{ id: 'b' }] }] };
  assert.deepEqual(photoList(p, 'all'), [{ id: 'a' }]);
  assert.deepEqual(photoList(p, '0'), []);
  setPhotos(p, '0', [{ id: 'c' }]);
  assert.deepEqual(p.colors[0].images, [{ id: 'c' }]);
  assert.deepEqual(p.colors[1].images, [{ id: 'b' }]);
  assert.deepEqual(moveTo(['a', 'b', 'c'], 0, 2), ['b', 'c', 'a']);
  assert.deepEqual(moveTo(['a', 'b'], 0, -1), ['a', 'b']);
  assert.deepEqual(moveTo(['a', 'b'], 1, 5), ['a', 'b']);
  assert.deepEqual(removeAt(['a', 'b', 'c'], 1), ['a', 'c']);
});

test('era helpers: move a slug one place, and name each era state', () => {
  assert.deepEqual(moveSlug(['a', 'b', 'c'], 'b', -1), ['b', 'a', 'c']);
  assert.deepEqual(moveSlug(['a', 'b', 'c'], 'a', -1), ['a', 'b', 'c']);
  assert.deepEqual(moveSlug(['a', 'b', 'c'], 'c', 1), ['a', 'b', 'c']);
  const now = new Date('2026-06-01T00:00:00Z');
  assert.equal(eraStatus({ state: 'draft' }, now), 'Draft');
  assert.equal(eraStatus({ state: 'archived' }, now), 'Archived');
  assert.equal(eraStatus({ state: 'published', dropsAt: null, endsAt: null }, now), 'Live');
  assert.equal(eraStatus({ state: 'published', endsAt: '2026-05-01T00:00:00Z' }, now), 'Ended');
  assert.match(eraStatus({ state: 'published', dropsAt: '2026-07-04T12:00:00Z' }, now), /^Drops .*4/);
});

test('a photo change is an unsaved edit that the save bar calls photos, and goes in the product body', async () => {
  const { editable, pendingSummary, productBody } = await import('../assets/js/inventory-products.js');
  const o = { id: 'p', era: 'e', status: 'draft', name: 'P', sizes: ['M'], colors: [{ name: 'Red', hex: '#ff0000' }], skus: {} };
  const e = editable(o);
  assert.equal(pendingSummary(o, e, {}).text, '');
  setPhotos(e, '0', [{ id: 'a'.repeat(24), width: 900, height: 900, widths: [480, 900], ext: 'webp' }]);
  assert.equal(pendingSummary(o, e, {}).text, 'Unsaved: photos');
  assert.equal(productBody(o, e).product.colors[0].images.length, 1);
});
