import test from 'node:test';
import assert from 'node:assert/strict';
import { variantWidths, photoPath, manifestEntry } from '../data/photos.js';

test('variantWidths keeps standard widths up to the photo and adds its own width under 1440', () => {
  assert.deepEqual(variantWidths(2400), [480, 960, 1440]);
  assert.deepEqual(variantWidths(1200), [480, 960, 1200]);
  assert.deepEqual(variantWidths(720), [480, 720]);
  assert.deepEqual(variantWidths(400), [400]);
});
test('photoPath and manifestEntry use relative media paths', () => {
  const ref = { id: 'a'.repeat(24), width: 1200, height: 1500, widths: [480, 960, 1200], ext: 'webp' };
  assert.equal(photoPath(ref), `media/${'a'.repeat(24)}-1200.webp`);
  assert.deepEqual(manifestEntry(ref).variants.map(v => v.width), [480, 960, 1200]);
});
