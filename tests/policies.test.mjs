import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = f => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');

test('policies describe WiPay payment, GCT, the fee, shipping and currency estimates', () => {
  const html = read('policies.html');
  for (const gone of ['No payment is collected', 'Checkout does not ask for card or bank details']) assert.ok(!html.includes(gone), gone);
  for (const s of ['WiPay', 'non-refundable', 'GCT', 'id="shipping"', 'estimates', 'encrypted', 'postal address', 'href="#shipping"']) assert.ok(html.includes(s), s);
  const day = html.match(/Last updated <time datetime="(\d{4}-\d{2}-\d{2})">/)[1];
  assert.ok(day >= '2026-11-03', `last updated ${day}`);
});

test('the store footer links the shipping policy', () => {
  assert.ok(read('index.html').includes('href="/policies.html#shipping"'));
});
