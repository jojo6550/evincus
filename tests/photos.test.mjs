import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { addPhotos, addToSource, kebab, nextNames } from '../scripts/photos.mjs';

const ERA = `export const era = {
  slug: "x",
  hero: "hero.jpg",
};

export const products = [
  {
    id: "plain-tee",
    colors: [{ name: "Black", hex: "#151515" }],
    images: ["plain-tee-1.jpg"],
  },
  {
    id: "print-tee",
    colors: [
      {
        name: "Black, red print",
        hex: "#151515",
        images: ["print-tee-black-red-print-1.webp"]
      },
      {
        name: "White",
        hex: "#FFFFFF"
      }
    ],
  },
];
`;

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'photos-'));
  mkdirSync(join(dir, 'x', 'img'), { recursive: true });
  writeFileSync(join(dir, 'x', 'era.js'), ERA);
  for (const f of ['hero.jpg', 'plain-tee-1.jpg', 'print-tee-black-red-print-1.webp']) writeFileSync(join(dir, 'x', 'img', f), '');
  return { dir, root: pathToFileURL(dir + '/') };
}

const photo = async (dir, name) => {
  const path = join(dir, name);
  await sharp({ create: { width: 4000, height: 3000, channels: 3, background: '#a33' } }).jpeg().toFile(path);
  return path;
};
const load = async dir => import(`${pathToFileURL(join(dir, 'x', 'era.js')).href}?t=${Math.random()}`);

test('names continue from the highest number and kebab colours like the existing files', () => {
  assert.equal(kebab('Black, red print'), 'black-red-print');
  assert.deepEqual(nextNames(['tee-1.jpg', 'tee-3.webp', 'tee-shirt-9.jpg'], 'tee', 2), ['tee-4.webp', 'tee-5.webp']);
  assert.deepEqual(nextNames([], 'tee', 1), ['tee-1.webp']);
});

test('appends to the product list, a colour list, or adds a list to a colour without one', async () => {
  const { dir, root } = setup();
  const a = await photo(dir, 'a.jpg');
  await addPhotos({ root, era: 'x', target: 'plain-tee', photos: [a, a] });
  await addPhotos({ root, era: 'x', target: 'print-tee', color: 'black, RED print', photos: [a] });
  await addPhotos({ root, era: 'x', target: 'print-tee', color: 'White', photos: [a] });
  const { products } = await load(dir);
  assert.deepEqual(products[0].images, ['plain-tee-1.jpg', 'plain-tee-2.webp', 'plain-tee-3.webp']);
  assert.deepEqual(products[1].colors[0].images, ['print-tee-black-red-print-1.webp', 'print-tee-black-red-print-2.webp']);
  assert.deepEqual(products[1].colors[1].images, ['print-tee-white-1.webp']);
  const img = join(dir, 'x', 'img');
  const meta = await sharp(join(img, 'plain-tee-2.webp')).metadata();
  assert.equal(meta.format, 'webp');
  assert.ok(Math.max(meta.width, meta.height) <= 1800 && statSync(join(img, 'plain-tee-2.webp')).size <= 500 * 1024);
});

test('hero replaces the hero file name', async () => {
  const { dir, root } = setup();
  await addPhotos({ root, era: 'x', target: 'hero', photos: [await photo(dir, 'h.jpg')] });
  assert.equal((await load(dir)).era.hero, 'hero.webp');
});

test('bad input writes nothing', async () => {
  const { dir, root } = setup();
  const a = await photo(dir, 'a.jpg');
  const before = readFileSync(join(dir, 'x', 'era.js'), 'utf8') + readdirSync(join(dir, 'x', 'img'));
  const bad = [
    [{ era: 'nope', target: 'plain-tee', photos: [a] }, /No era/],
    [{ era: 'x', target: 'nope', photos: [a] }, /no product "nope"/],
    [{ era: 'x', target: 'print-tee', photos: [a] }, /pass --color/],
    [{ era: 'x', target: 'print-tee', color: 'Pink', photos: [a] }, /no colour "Pink"/],
    [{ era: 'x', target: 'plain-tee', photos: [join(dir, 'missing.jpg')] }, /doesn't exist/],
    [{ era: 'x', target: 'plain-tee', photos: [join(dir, 'x', 'era.js')] }, /./], // not an image
  ];
  for (const [args, msg] of bad) await assert.rejects(addPhotos({ root, ...args }), msg);
  assert.equal(readFileSync(join(dir, 'x', 'era.js'), 'utf8') + readdirSync(join(dir, 'x', 'img')), before);
});

test('single-quoted source is matched too', () => {
  const src = `{ id: 'a', images: ['a-1.jpg'] }`;
  assert.equal(addToSource(src, { productId: 'a', current: ['a-1.jpg'], files: ['a-2.webp'] }), `{ id: 'a', images: ["a-1.jpg", "a-2.webp"] }`);
});
