import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { imagesFor } from '../data/catalog.js';
import { CATALOG, FOLDERS } from '../data/eras/index.js';

const root = new URL('../', import.meta.url);
const { eras, products } = CATALOG;
const site = JSON.parse(readFileSync(new URL('data/site.json', root), 'utf8'));
const erasDir = new URL('data/eras/', root);
const dirs = readdirSync(erasDir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const IMAGE_NAME = /^[a-z0-9]+(-[a-z0-9]+)*\.(jpg|png|webp)$/;
const MAX_BYTES = 500 * 1024;

test('every era folder is listed in index.js and every listed era has a folder', () => {
  assert.deepEqual([...dirs].sort(), [...FOLDERS].sort());
});

test('each era.js declares the slug of its folder', async () => {
  for (const dir of dirs) {
    const { era } = await import(new URL(`${dir}/era.js`, erasDir).href);
    assert.equal(era.slug, dir, `data/eras/${dir}/era.js has slug "${era.slug}"`);
  }
});

test('era photos are bare, safely named files in their own img folder', () => {
  for (const e of eras) {
    const prefix = `data/eras/${e.slug}/img/`;
    const files = readdirSync(new URL(`${e.slug}/img/`, erasDir)); // exact case: Pages is case-sensitive
    const refs = [e.hero, ...products.filter(p => p.era === e.slug).flatMap(p => [
      ...(p.images ?? []),
      ...p.colors.flatMap(c => c.images ?? []),
    ])];
    for (const ref of refs) {
      assert.ok(ref.startsWith(prefix), `${ref} is not in ${prefix}`);
      const file = ref.slice(prefix.length);
      assert.match(file, IMAGE_NAME, `${e.slug}: "${file}" must be a bare lowercase-kebab .jpg/.png/.webp filename`);
      assert.ok(files.includes(file), `${prefix}${file} is missing (names are case-sensitive)`);
    }
  }
});

test('no era photo is over 500 KB', () => {
  for (const dir of dirs) {
    for (const file of readdirSync(new URL(`${dir}/img/`, erasDir))) {
      const { size } = statSync(new URL(`${dir}/img/${file}`, erasDir));
      assert.ok(size <= MAX_BYTES, `data/eras/${dir}/img/${file} is ${Math.round(size / 1024)} KB (max 500 KB)`);
    }
  }
});

test('site.json does not use era photos', () => {
  assert.ok(!JSON.stringify(site).includes('data/eras/'), 'non-era photos belong in assets/img/');
});

test('eras are well formed', () => {
  assert.ok(eras.length > 0);
  const slugs = new Set();
  for (const e of eras) {
    assert.match(e.slug, /^[a-z0-9-]+$/, `bad slug ${e.slug}`);
    assert.ok(!slugs.has(e.slug), `duplicate era ${e.slug}`);
    slugs.add(e.slug);
    assert.ok(typeof e.name === 'string' && e.name, `${e.slug}.name`);
    for (const k of ['tagline', 'story', 'hero']) assert.equal(typeof e[k], 'string', `${e.slug}.${k}`);
    for (const k of ['dropsAt', 'endsAt']) {
      assert.ok(e[k] === null || (ISO.test(e[k]) && !Number.isNaN(Date.parse(e[k]))), `${e.slug}.${k} must be null or ISO with offset`);
    }
    if (e.dropsAt && e.endsAt) assert.ok(Date.parse(e.endsAt) > Date.parse(e.dropsAt), `${e.slug} ends before it drops`);
  }
});

test('products are well formed and point at real eras', () => {
  const slugs = new Set(eras.map(e => e.slug));
  const categories = new Set(site.categories.map(c => c.id));
  const ids = new Set();
  for (const p of products) {
    assert.match(p.id, /^[a-z0-9-]+$/, `bad id ${p.id}`);
    assert.ok(!ids.has(p.id), `duplicate product ${p.id}`);
    ids.add(p.id);
    assert.ok(slugs.has(p.era), `${p.id} points at missing era ${p.era}`);
    assert.ok(categories.has(p.category), `${p.id} has unknown category ${p.category}`);
    assert.ok(Number.isInteger(p.priceCents) && p.priceCents > 0, `${p.id}.priceCents`);
    assert.ok(Array.isArray(p.sizes) && p.sizes.length, `${p.id}.sizes`);
    assert.ok(Array.isArray(p.colors) && p.colors.length, `${p.id}.colors`);
    for (const s of p.sizes) assert.ok(!s.includes('|'), `${p.id} size ${s} contains |`);
    for (const c of p.colors) {
      assert.ok(c.name && !c.name.includes('|'), `${p.id} colour ${c.name}`);
      assert.match(c.hex, /^#[0-9A-Fa-f]{6}$/, `${p.id} colour ${c.name} hex`);
    }
    assert.ok(imagesFor(p, p.colors[0].name)?.length, `${p.id} has no images`);
    assert.equal(typeof p.soldOut, 'boolean', `${p.id}.soldOut`);
    assert.ok(Array.isArray(p.soldOutVariants), `${p.id}.soldOutVariants`);
    for (const v of p.soldOutVariants) {
      const [color, size, ...rest] = v.split('|');
      assert.ok(!rest.length && p.colors.some(c => c.name === color) && p.sizes.includes(size), `${p.id} soldOutVariants "${v}"`);
    }
  }
});

test('site data is present', () => {
  assert.ok(site.categories.some(c => c.id === 'all'));
  assert.ok(site.lookbook.length > 0);
  assert.ok(typeof site.careNote === 'string' && site.careNote);
});
