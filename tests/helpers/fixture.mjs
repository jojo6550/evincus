// Small fixed catalog and clock for tests. Real data/*.json is only checked by data.test.mjs.
export const NOW = Date.parse('2026-10-03T12:00:00Z');

export const FIXTURE = {
  eras: [
    { slug: 'future', name: 'Future', tagline: 'Soon', story: 'Secret story', hero: 'https://img.test/future.jpg',
      dropsAt: '2026-10-10T17:00:00-05:00', endsAt: null },
    { slug: 'alpha', name: 'Alpha', tagline: 'Now', story: 'Alpha story', hero: 'https://img.test/alpha.jpg',
      dropsAt: '2026-01-01T00:00:00Z', endsAt: null },
    { slug: 'old', name: 'Old', tagline: 'Was', story: 'Old story', hero: 'https://img.test/old.jpg',
      dropsAt: null, endsAt: '2026-06-01T00:00:00Z' },
  ],
  products: [
    { id: 'alpha-tee', era: 'alpha', name: 'Alpha <Tee>', category: 'tees', priceCents: 3499, fabric: 'Cotton',
      sizes: ['S', 'M'],
      colors: [
        { name: 'Black, white print', hex: '#151515', images: ['https://img.test/a1.png', 'https://img.test/a2.png'] },
        { name: 'White', hex: '#F4F4F2' },
      ],
      images: ['https://img.test/a0.png'] },
    { id: 'alpha-hood', era: 'alpha', name: 'Alpha Hood', category: 'outerwear', priceCents: 4599, fabric: 'Fleece',
      sizes: ['M'], colors: [{ name: 'Black', hex: '#151515' }], images: ['https://img.test/h.png'] },
    { id: 'future-tee', era: 'future', name: 'Future Tee', category: 'tees', priceCents: 9999, fabric: 'Cotton',
      sizes: ['M'], colors: [{ name: 'Black', hex: '#151515' }], images: ['https://img.test/f.png'] },
    { id: 'old-tee', era: 'old', name: 'Old Tee', category: 'tees', priceCents: 2000, fabric: 'Cotton',
      sizes: ['M'], colors: [{ name: 'Black', hex: '#151515' }], images: ['https://img.test/o.png'] },
  ],
  site: { categories: [{ id: 'all', name: 'Everything' }], lookbook: [], careNote: 'Wash cold.' },
};

// 10 on hand per variant; two variants are out.
export function fixtureStock(data = FIXTURE) {
  const out = new Set(['alpha-hood|Black|M', 'alpha-tee|White|M']);
  return new Map(data.products.flatMap(p => p.colors.flatMap(c => p.sizes.map(s => {
    const k = `${p.id}|${c.name}|${s}`;
    return [k, { onHand: out.has(k) ? 0 : 10, committed: 0 }];
  }))));
}
