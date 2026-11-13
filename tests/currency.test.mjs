import test from 'node:test';
import assert from 'node:assert/strict';
import { detectCurrency, formatIn, formatPrice, initCurrency, productPrice, onCurrencyChange, currentCurrency } from '../assets/js/currency.js';

const RATES = { USD: 1, JMD: 157.2, EUR: 0.92 };
// Stand-ins for the footer <select> and the attribution link.
const el = () => ({ hidden: true, innerHTML: '', value: '', listeners: {}, addEventListener(t, fn) { this.listeners[t] = fn; } });
const memoryStorage = (init = {}) => { const m = new Map(Object.entries(init)); return { getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), m }; };

test('detection uses the first region subtag; no region or no rate falls back to USD', () => {
  assert.equal(detectCurrency(['en-JM', 'en-US'], { USD: 1, JMD: 157.2 }), 'JMD');
  assert.equal(detectCurrency(['en'], { USD: 1, JMD: 157.2 }), 'USD');
  assert.equal(detectCurrency(['fr-ZZ'], { USD: 1 }), 'USD');
  assert.equal(detectCurrency(['ja-JP'], { USD: 1, JMD: 157.2 }), 'USD'); // no JPY rate
  assert.equal(detectCurrency(['zh-Hant-TW', 'en-JM'], { USD: 1, JMD: 157.2 }), 'USD', 'the first region decides');
  assert.equal(detectCurrency(undefined, RATES), 'USD');
});

test('formatting: USD plain, others as estimates, a missing rate never NaN', () => {
  assert.equal(formatIn(1000, 'USD', { USD: 1 }), '$10.00');
  assert.equal(formatIn(5000, 'JMD', { USD: 1, JMD: 157.2 }), '≈ JMD 7,860.00');
  assert.equal(formatIn(5000, 'JPY', { USD: 1 }), '$50.00');
  assert.equal(formatIn(5000, 'JPY', { USD: 1, JPY: 150.4 }), '≈ JPY 7,520');
  assert.equal(formatIn(5000, 'EUR', { USD: 1, EUR: Number.NaN }), '$50.00');
});

test('init: a stored choice wins over detection; the picker lists rated currencies; changes notify', async () => {
  const select = el(), credit = el(), storage = memoryStorage({ evincus_currency: 'EUR' });
  const seen = [];
  onCurrencyChange(code => seen.push(code));
  await initCurrency(select, credit, { load: async () => ({ base: 'USD', rates: RATES }), storage, languages: ['en-JM'] });
  assert.equal(currentCurrency(), 'EUR');
  assert.equal(select.value, 'EUR');
  assert.equal(select.hidden, false);
  assert.equal(credit.hidden, false);
  assert.deepEqual([...select.innerHTML.matchAll(/value="([A-Z]{3})"/g)].map(m => m[1]).sort(), ['EUR', 'JMD', 'USD']);
  assert.match(formatPrice(1000), /^≈ EUR/);
  select.value = 'JMD';
  select.listeners.change();
  assert.equal(storage.m.get('evincus_currency'), 'JMD');
  assert.equal(seen.at(-1), 'JMD');
});

test('init works with storage blocked, and a failed rates request leaves USD and the picker hidden', async () => {
  const blocked = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  const select = el(), credit = el();
  await initCurrency(select, credit, { load: async () => ({ base: 'USD', rates: RATES }), storage: blocked, languages: ['en-JM'] });
  assert.equal(currentCurrency(), 'JMD');
  select.value = 'USD';
  select.listeners.change();
  assert.equal(currentCurrency(), 'USD');

  const s2 = el(), c2 = el();
  await initCurrency(s2, c2, { load: async () => { throw new Error('down'); }, storage: memoryStorage(), languages: ['en-JM'] });
  assert.equal(currentCurrency(), 'USD');
  assert.equal(formatPrice(1000), '$10.00');
  assert.equal(s2.hidden, true);
  assert.equal(c2.hidden, true);
});

test('a product with fixed JMD prices shows them exactly in JMD, and estimates everywhere else', async () => {
  await initCurrency(null, null, { load: async () => ({ base: 'USD', rates: RATES }), storage: memoryStorage(), languages: ['en-US'] });
  const p = { priceCents: 5000, compareAtCents: 6300, jmd: { priceCents: 800000, compareAtCents: 1000000 } };
  assert.equal(productPrice(p, 'priceCents', 'JMD'), 'JMD 8,000.00');
  assert.equal(productPrice(p, 'compareAtCents', 'JMD'), 'JMD 10,000.00');
  assert.equal(productPrice(p, 'priceCents', 'USD'), formatIn(5000, 'USD', RATES));
  assert.equal(productPrice(p, 'priceCents', 'EUR'), formatIn(5000, 'EUR', RATES));
  assert.equal(productPrice({ priceCents: 5000 }, 'priceCents', 'JMD'), formatIn(5000, 'JMD', RATES));
});
