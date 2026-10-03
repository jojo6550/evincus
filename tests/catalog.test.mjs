import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_QTY, lineKey, eraStatus, cacheSeconds, lineStatus, publicView, eraSummary, eraDetail, imagesFor, money, findProduct,
} from '../data/catalog.js';
import { FIXTURE, NOW } from './helpers/fixture.mjs';

const at = ms => new Date(ms);

test('era is upcoming until the exact drop instant, then live', () => {
  const era = { dropsAt: '2026-10-10T17:00:00-05:00', endsAt: null };
  const drop = Date.parse(era.dropsAt);
  assert.equal(eraStatus(era, at(drop - 1)), 'upcoming');
  assert.equal(eraStatus(era, at(drop)), 'live');
  assert.equal(eraStatus(era, at(drop + 1)), 'live');
});

test('era is archived from the exact end instant', () => {
  const era = { dropsAt: null, endsAt: '2026-06-01T00:00:00Z' };
  const end = Date.parse(era.endsAt);
  assert.equal(eraStatus(era, at(end - 1)), 'live');
  assert.equal(eraStatus(era, at(end)), 'archived');
  assert.equal(eraStatus(era, at(end + 1)), 'archived');
});

test('null dates mean always live', () => {
  assert.equal(eraStatus({ dropsAt: null, endsAt: null }, at(0)), 'live');
});

test('cacheSeconds caps at the max and never runs past the next boundary', () => {
  assert.equal(cacheSeconds([], at(NOW)), 60);
  assert.equal(cacheSeconds([{ dropsAt: new Date(NOW + 30_500).toISOString(), endsAt: null }], at(NOW)), 30);
  assert.equal(cacheSeconds([{ dropsAt: new Date(NOW + 400).toISOString(), endsAt: null }], at(NOW)), 0);
  assert.equal(cacheSeconds([{ dropsAt: new Date(NOW - 1).toISOString(), endsAt: null }], at(NOW)), 60);
  assert.equal(cacheSeconds([{ dropsAt: null, endsAt: new Date(NOW + 10_000).toISOString() }], at(NOW)), 10);
});

test('publicView hides products of upcoming eras and sets buyable', () => {
  const v = publicView(FIXTURE, at(NOW));
  assert.deepEqual(v.eras.map(e => [e.slug, e.status]), [['future', 'upcoming'], ['alpha', 'live'], ['old', 'archived']]);
  assert.deepEqual(v.products.map(p => [p.id, p.buyable]), [['alpha-tee', true], ['alpha-hood', false], ['old-tee', false]]);
});

test('lineStatus covers every status', () => {
  const s = item => lineStatus(FIXTURE, at(NOW), item);
  assert.equal(s({ id: 'alpha-tee', color: 'Black, white print', size: 'S' }), 'ok');
  assert.equal(s({ id: 'alpha-tee', color: 'White', size: 'M' }), 'sold-out');
  assert.equal(s({ id: 'alpha-hood', color: 'Black', size: 'M' }), 'sold-out');
  assert.equal(s({ id: 'future-tee', color: 'Black', size: 'M' }), 'not-released');
  assert.equal(s({ id: 'old-tee', color: 'Black', size: 'M' }), 'era-ended');
  assert.equal(s({ id: 'nope', color: 'Black', size: 'M' }), 'unknown-item');
  assert.equal(s({ id: 'alpha-tee', color: 'Neon', size: 'S' }), 'unknown-item');
  assert.equal(s({ id: 'alpha-tee', color: 'White', size: 'XXL' }), 'unknown-item');
});

test('a product whose era is missing counts as not released and is hidden', () => {
  const data = { eras: [], products: [FIXTURE.products[0]] };
  assert.equal(lineStatus(data, at(NOW), { id: 'alpha-tee', color: 'White', size: 'S' }), 'not-released');
  assert.equal(publicView(data, at(NOW)).products.length, 0);
});

test('eraSummary hides story; upcoming eras report zero products', () => {
  const v = publicView(FIXTURE, at(NOW));
  const [future, alpha] = v.eras;
  assert.deepEqual(eraSummary(future, v.products), {
    slug: 'future', name: 'Future', tagline: 'Soon', hero: 'https://img.test/future.jpg',
    status: 'upcoming', dropsAt: '2026-10-10T17:00:00-05:00', endsAt: null, productCount: 0,
  });
  assert.equal(eraSummary(alpha, v.products).productCount, 2);
  assert.ok(!('story' in eraSummary(alpha, v.products)));
});

test('eraDetail includes story except for upcoming eras', () => {
  const v = publicView(FIXTURE, at(NOW));
  assert.equal(eraDetail(v.eras[1]).story, 'Alpha story');
  assert.ok(!('story' in eraDetail(v.eras[0])));
});

test('imagesFor prefers colour images, then product images', () => {
  const tee = FIXTURE.products[0];
  assert.deepEqual(imagesFor(tee, 'Black, white print'), ['https://img.test/a1.png', 'https://img.test/a2.png']);
  assert.deepEqual(imagesFor(tee, 'White'), ['https://img.test/a0.png']);
  const noProductImages = { colors: [{ name: 'A', images: ['x'] }, { name: 'B' }] };
  assert.deepEqual(imagesFor(noProductImages, 'B'), ['x']);
});

test('money, lineKey, findProduct, MAX_QTY', () => {
  assert.equal(money(4599), '$45.99');
  assert.equal(money(0), '$0.00');
  assert.equal(lineKey('a', 'Black, white print', 'S'), 'a|Black, white print|S');
  assert.equal(findProduct(FIXTURE.products, 'old-tee').name, 'Old Tee');
  assert.equal(findProduct(FIXTURE.products, 'nope'), undefined);
  assert.equal(MAX_QTY, 10);
});
