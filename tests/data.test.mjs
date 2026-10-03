import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { imagesFor } from '../data/catalog.js';

const read = path => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const eras = read('../data/eras.json');
const products = read('../data/products.json');
const site = read('../data/site.json');
const snapshot = read('./fixtures/images-snapshot.json');

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

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

test('images match the pre-migration snapshot', () => {
  assert.deepEqual(Object.keys(snapshot).sort(), products.map(p => p.id).sort());
  for (const p of products) {
    for (const c of p.colors) assert.deepEqual(imagesFor(p, c.name), snapshot[p.id][c.name], `${p.id} / ${c.name}`);
  }
});

test('site data is present', () => {
  assert.ok(site.categories.some(c => c.id === 'all'));
  assert.ok(site.lookbook.length > 0);
  assert.ok(typeof site.careNote === 'string' && site.careNote);
});
