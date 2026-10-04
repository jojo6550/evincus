import test from 'node:test';
import assert from 'node:assert/strict';
import { merge, imgPath } from '../data/eras/merge.js';

const modules = () => [
  {
    era: { slug: 'alpha', name: 'Alpha', tagline: 'T', story: 'S', hero: 'hero.jpg', dropsAt: null, endsAt: null },
    products: [
      { id: 'a-tee', name: 'A Tee', images: ['a-tee-1.jpg'],
        colors: [{ name: 'Black', hex: '#000000', images: ['a-tee-black-1.png'] }, { name: 'White', hex: '#FFFFFF' }] },
      { id: 'a-hood', name: 'A Hood', images: ['a-hood-1.jpg'], colors: [{ name: 'Black', hex: '#000000' }] },
    ],
  },
  {
    era: { slug: 'beta', name: 'Beta', tagline: 'T', story: 'S', hero: 'hero.png', dropsAt: null, endsAt: null },
    products: [
      { id: 'b-tee', name: 'B Tee', colors: [{ name: 'Black', hex: '#000000', images: ['b-tee-black-1.jpg'] }] },
    ],
  },
];

test('imgPath builds a site-relative path', () => {
  assert.equal(imgPath('alpha', 'hero.jpg'), 'data/eras/alpha/img/hero.jpg');
});

test('expands filenames, stamps era, keeps era and product order', () => {
  assert.deepEqual(merge(modules()), {
    eras: [
      { slug: 'alpha', name: 'Alpha', tagline: 'T', story: 'S', hero: 'data/eras/alpha/img/hero.jpg', dropsAt: null, endsAt: null },
      { slug: 'beta', name: 'Beta', tagline: 'T', story: 'S', hero: 'data/eras/beta/img/hero.png', dropsAt: null, endsAt: null },
    ],
    products: [
      { id: 'a-tee', era: 'alpha', name: 'A Tee', images: ['data/eras/alpha/img/a-tee-1.jpg'],
        colors: [
          { name: 'Black', hex: '#000000', images: ['data/eras/alpha/img/a-tee-black-1.png'] },
          { name: 'White', hex: '#FFFFFF' },
        ] },
      { id: 'a-hood', era: 'alpha', name: 'A Hood', images: ['data/eras/alpha/img/a-hood-1.jpg'],
        colors: [{ name: 'Black', hex: '#000000' }] },
      { id: 'b-tee', era: 'beta', name: 'B Tee',
        colors: [{ name: 'Black', hex: '#000000', images: ['data/eras/beta/img/b-tee-black-1.jpg'] }] },
    ],
  });
});

test('a product with only colour images gets no images key', () => {
  const b = merge(modules()).products.find(p => p.id === 'b-tee');
  assert.equal('images' in b, false);
  assert.equal('images' in merge(modules()).products[0].colors[1], false);
});

test('does not mutate the era modules', () => {
  const input = modules();
  const before = structuredClone(input);
  merge(input);
  assert.deepEqual(input, before);
});
