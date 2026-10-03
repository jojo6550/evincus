import test from 'node:test';
import assert from 'node:assert/strict';
import { call, captureLogs } from './helpers/fake-env.mjs';

const item = (over = {}) => ({ id: 'alpha-tee', color: 'Black, white print', size: 'S', qty: 2, ...over });
const quote = items => call('POST', '/api/bag/quote', { body: { items } });

test('prices from the catalog, ignores client prices, keeps comma colour names intact', async () => {
  const { status, json } = await quote([{ ...item(), price: 0.01, priceCents: 1 }]);
  assert.equal(status, 200);
  assert.deepEqual(json.lines[0], {
    key: 'alpha-tee|Black, white print|S', id: 'alpha-tee', color: 'Black, white print', size: 'S', qty: 2,
    status: 'ok', name: 'Alpha <Tee>', image: 'https://img.test/a1.png', unitCents: 3499, totalCents: 6998,
  });
  assert.equal(json.subtotalCents, 6998);
  assert.equal(json.shippingCents, 500);
  assert.equal(json.totalCents, 7498);
  assert.equal(json.checkoutReady, true);
});

test('one bad line does not fail the bag; only countable lines are totalled', async () => {
  const { status, json } = await quote([
    item(),
    item({ color: 'White', size: 'M', qty: 1 }),
    { id: 'alpha-hood', color: 'Black', size: 'M', qty: 1 },
    { id: 'future-tee', color: 'Black', size: 'M', qty: 1 },
    { id: 'old-tee', color: 'Black', size: 'M', qty: 1 },
    { id: 'gone', color: 'Black', size: 'M', qty: 1 },
  ]);
  assert.equal(status, 200);
  assert.deepEqual(json.lines.map(l => l.status), ['ok', 'sold-out', 'sold-out', 'not-released', 'era-ended', 'unknown-item']);
  assert.equal(json.subtotalCents, 6998);
  assert.equal(json.totalCents, 7498);
  assert.equal(json.checkoutReady, false);
});

test('not-released and unknown lines leak no name, image or price', async () => {
  const { json, text } = await quote([{ id: 'future-tee', color: 'Black', size: 'M', qty: 1 }, { id: 'gone', color: 'X', size: 'Y', qty: 1 }]);
  for (const l of json.lines) for (const k of ['name', 'image', 'unitCents', 'totalCents']) assert.ok(!(k in l), `${l.status} has ${k}`);
  assert.ok(!text.includes('Future Tee'));
  assert.ok(!text.includes('9999'));
});

test('absurd quantities are capped at 10 and stay checkout-ready', async () => {
  const { json } = await quote([item({ qty: 1_000_000 })]);
  assert.equal(json.lines[0].status, 'qty-capped');
  assert.equal(json.lines[0].qty, 10);
  assert.equal(json.lines[0].totalCents, 34990);
  assert.equal(json.checkoutReady, true);
});

test('shipping is zero when nothing is countable', async () => {
  const { json } = await quote([{ id: 'old-tee', color: 'Black', size: 'M', qty: 1 }]);
  assert.equal(json.shippingCents, 0);
  assert.equal(json.totalCents, 0);
  assert.equal(json.checkoutReady, false);
});

test('malformed bags are 400 invalid-cart', async () => {
  const many = Array.from({ length: 51 }, (_, i) => item({ size: `S${i}` }));
  const bodies = [{}, { items: [] }, { items: 'x' }, { items: many }, { items: [item({ qty: '2' })] },
    { items: [item({ qty: 0 })] }, { items: [item({ qty: 1.5 })] }, { items: [item(), item()] },
    { items: [item({ color: 'a|b' })] }, { items: [null] }, { items: [item({ id: 7 })] }];
  for (const body of bodies) {
    const r = await call('POST', '/api/bag/quote', { body });
    assert.equal(r.status, 400, JSON.stringify(body).slice(0, 80));
    assert.equal(r.json.error.code, 'invalid-cart');
  }
  const raw = await call('POST', '/api/bag/quote', { raw: 'not json' });
  assert.equal(raw.status, 400);
});

test('bodies over 16 KB are 413', async () => {
  const r = await call('POST', '/api/bag/quote', { raw: JSON.stringify({ items: [item()], pad: 'x'.repeat(17000) }) });
  assert.equal(r.status, 413);
  assert.equal(r.json.error.code, 'too-large');
});

test('quote logs status counts and total', async () => {
  const logs = captureLogs();
  try { await quote([item(), { id: 'old-tee', color: 'Black', size: 'M', qty: 1 }]); } finally { logs.restore(); }
  const line = logs.lines.find(l => l.event === 'bag.quoted');
  assert.deepEqual(line.statuses, { ok: 1, 'era-ended': 1 });
  assert.equal(line.totalCents, 7498);
});
