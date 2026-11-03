import test from 'node:test';
import assert from 'node:assert/strict';
import { charges, TAX, PROCESSING_FEE } from '../data/fees.js';
import { quote } from '../server/lib/pricing.js';
import { applyStock } from '../data/catalog.js';
import { FIXTURE, NOW, fixtureStock } from './helpers/fixture.mjs';

test('charges rounds half-up per order', () => {
  assert.deepEqual(charges(10000), { taxCents: 1500, feeCents: 555, totalCents: 12055 });
  assert.deepEqual(charges(6998), { taxCents: 1050, feeCents: 389, totalCents: 8437 });
  assert.deepEqual(charges(33), { taxCents: 5, feeCents: 2, totalCents: 40 });
  assert.deepEqual(charges(0), { taxCents: 0, feeCents: 0, totalCents: 0 });
});

test('rates are the shared constants', () => {
  assert.deepEqual(TAX, { label: 'GCT', bps: 1500 });
  assert.deepEqual(PROCESSING_FEE, { label: 'Processing fee', bps: 483 });
});

test('quote returns the breakdown and its sum', () => {
  const q = quote(applyStock(FIXTURE, fixtureStock()), new Date(NOW), [{ id: 'alpha-tee', color: 'Black, white print', size: 'S', qty: 2 }]);
  assert.equal(q.subtotalCents, 6998); assert.equal(q.taxCents, 1050); assert.equal(q.feeCents, 389);
  assert.equal(q.totalCents, 8437);
  assert.deepEqual(q.tax, { label: 'GCT', bps: 1500 }); assert.deepEqual(q.fee, { label: 'Processing fee', bps: 483 });
});

test('bag breakdown shows four rows with rates from the quote', async () => {
  const { breakdownHtml } = await import('../assets/js/bag.js');
  const html = breakdownHtml({ subtotalCents: 6998, ...charges(6998), tax: TAX, fee: PROCESSING_FEE });
  for (const text of ['Subtotal', 'GCT (15%)', 'Processing fee (4.83%, non-refundable)', '$84.37', 'USD']) assert.ok(html.includes(text), text);
  assert.ok(breakdownHtml({ subtotalCents: 0, ...charges(0), tax: { label: 'GCT', bps: 1550 }, fee: PROCESSING_FEE }).includes('GCT (15.5%)'));
});
