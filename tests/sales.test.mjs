import test from 'node:test';
import assert from 'node:assert/strict';
import { call, makeEnv, fakeUpstreams } from './helpers/fake-env.mjs';
import { FIXTURE, NOW } from './helpers/fixture.mjs';
import { applySales, bestSale, salePrice } from '../data/catalog.js';
import { SALES_KEY, SALE_GRACE_MS } from '../server/lib/sales.js';
import { addSale, endSale, makeSale, parseArgs } from '../scripts/discount.mjs';

const HOUR = 3_600_000;
const iso = ms => new Date(ms).toISOString();
const sale = (over = {}) => ({ id: 's1', percent: 20, eras: ['alpha'], label: null, startsAt: iso(NOW - HOUR), endsAt: iso(NOW + HOUR), ...over });
const envWith = (sales, over = {}) => {
  const env = makeEnv(over);
  env.ORDERS.store.set(SALES_KEY, { value: JSON.stringify(sales), opts: {} });
  return env;
};
const item = (over = {}) => ({ id: 'alpha-tee', color: 'Black, white print', size: 'S', qty: 2, ...over });

test('applySales discounts covered eras only and keeps the original price', () => {
  const d = applySales(FIXTURE, [sale()], NOW);
  const tee = d.products.find(p => p.id === 'alpha-tee');
  assert.equal(tee.priceCents, salePrice(3499, 20));
  assert.equal(tee.priceCents, 2799);
  assert.equal(tee.compareAtCents, 3499);
  assert.deepEqual(tee.sale, { id: 's1', percent: 20, endsAt: sale().endsAt });
  assert.equal(d.products.find(p => p.id === 'old-tee').priceCents, 2000);
});

test('sales outside their window, malformed ones, and over-limit percents do nothing', () => {
  const bad = [
    sale({ startsAt: iso(NOW + 1), endsAt: iso(NOW + HOUR) }),
    sale({ endsAt: iso(NOW) }),
    sale({ percent: 95 }),
    sale({ percent: 12.5 }),
    sale({ eras: [] }),
    { id: 'x' },
    null,
  ];
  const d = applySales(FIXTURE, bad, NOW);
  assert.deepEqual(d.products.map(p => p.priceCents), FIXTURE.products.map(p => p.priceCents));
  assert.equal(d.sales.length, 1, 'the scheduled sale is kept for cache expiry');
});

test('the deepest sale wins when several cover an era; null eras means everything', () => {
  const all = sale({ id: 'all', percent: 10, eras: null });
  const deep = sale({ id: 'deep', percent: 30 });
  assert.equal(bestSale([all, deep], 'alpha', NOW).id, 'deep');
  assert.equal(bestSale([all, deep], 'old', NOW).id, 'all');
});

test('GET /api/eras lists running sales and caps the cache at the sale end', async () => {
  const env = envWith([sale({ endsAt: iso(NOW + 25_000) }), sale({ id: 'later', startsAt: iso(NOW + HOUR), endsAt: iso(NOW + 2 * HOUR) })]);
  const { json, res } = await call('GET', '/api/eras', { env });
  assert.deepEqual(json.sales.map(s => [s.id, s.percent, s.eras]), [['s1', 20, ['alpha']]]);
  assert.equal(res.headers.get('cache-control'), 'public, max-age=25');
});

test('catalog cache expires when a scheduled sale starts', async () => {
  const env = envWith([sale({ startsAt: iso(NOW + 15_000), endsAt: iso(NOW + HOUR) })]);
  const { res } = await call('GET', '/api/eras/alpha', { env });
  assert.equal(res.headers.get('cache-control'), 'public, max-age=15');
});

test('era and product routes show sale prices', async () => {
  const env = envWith([sale()]);
  const era = await call('GET', '/api/eras/alpha', { env });
  assert.deepEqual(era.json.products.map(p => [p.id, p.priceCents, p.compareAtCents]), [['alpha-tee', 2799, 3499], ['alpha-hood', 3679, 4599]]);
  const product = await call('GET', '/api/products/alpha-tee', { env });
  assert.equal(product.json.priceCents, 2799);
  assert.equal(product.json.sale.percent, 20);
});

test('the bag is quoted at sale prices', async () => {
  const { json } = await call('POST', '/api/bag/quote', { body: { items: [item()] }, env: envWith([sale()]) });
  assert.equal(json.lines[0].unitCents, 2799);
  assert.equal(json.subtotalCents, 5598);
});

test('a sale that cannot be read prices at full price', async () => {
  const env = envWith([sale()]);
  env.ORDERS.failGets = key => key === SALES_KEY;
  const { json } = await call('POST', '/api/bag/quote', { body: { items: [item()] }, env });
  assert.equal(json.lines[0].unitCents, 3499);
});

test('a PayPal order priced during a sale captures inside the grace window, and is refused after it', async () => {
  fakeUpstreams();
  const ends = NOW + 1000;
  const env = envWith([sale({ endsAt: iso(ends) })]);
  const id = (await call('POST', '/api/orders', { body: { items: [item()] }, env })).json.id;

  const inGrace = await call('POST', '/api/orders/capture', { body: { orderID: id }, env, clock: () => ends + SALE_GRACE_MS - 1000 });
  assert.equal(inGrace.status, 200);
  assert.equal(inGrace.json.totalCents, 5598 + 500);

  const id2 = (await call('POST', '/api/orders', { body: { items: [item()] }, env })).json.id;
  const late = await call('POST', '/api/orders/capture', { body: { orderID: id2 }, env, clock: () => ends + SALE_GRACE_MS + 1000 });
  assert.equal(late.status, 409);
  assert.equal(late.json.error.code, 'capture-refused');
});

// ---------- npm run discount ----------

test('parseArgs reads a sale, list, end, and flags', () => {
  assert.deepEqual(parseArgs(['catastrophe,core', '3', '20%', '--label', 'Fall', '--url', 'https://preview.test']),
    { cmd: 'start', target: 'catastrophe,core', days: '3', percent: '20%', flags: { local: false, dryRun: false, label: 'Fall', starts: null, url: 'https://preview.test' } });
  assert.equal(parseArgs(['list']).cmd, 'list');
  assert.equal(parseArgs(['end', 'all']).id, 'all');
  assert.equal(parseArgs([]).cmd, 'help');
  assert.throws(() => parseArgs(['core', '3']), /Expected/);
  assert.throws(() => parseArgs(['core', '3', '20', '--nope']), /Unknown option/);
  assert.throws(() => parseArgs(['list', 'url=https://preview.test', 'local']), /not both/);
  assert.throws(() => parseArgs(['list', 'staging']), /url=/);
});

test('parseArgs takes options as plain words too, so npm never swallows them', () => {
  assert.deepEqual(parseArgs(['catastrophe', '3', '20', 'local', 'dry-run', 'label=Fall sale', 'starts=2026-11-27T00:00:00-05:00']).flags,
    { local: true, dryRun: true, label: 'Fall sale', starts: '2026-11-27T00:00:00-05:00', url: null });
  assert.equal(parseArgs(['list', 'url=https://preview.test']).flags.url, 'https://preview.test');
  assert.equal(parseArgs(['end', 'all', '--local']).flags.local, true);
});

test('makeSale builds a timed sale for eras, a group, or everything', () => {
  const known = ['catastrophe', 'core', 'reflection'];
  const s = makeSale({ target: 'catastrophe,core,core', days: '2', percent: '15%' }, known, NOW, 'abc');
  assert.deepEqual(s, { id: 'abc', percent: 15, eras: ['catastrophe', 'core'], label: null, startsAt: iso(NOW), endsAt: iso(NOW + 48 * HOUR) });
  assert.equal(makeSale({ target: 'ALL', days: 0.5, percent: 30 }, known, NOW).eras, null);
  assert.equal(makeSale({ target: 'all', days: 1, percent: 30, starts: iso(NOW + HOUR) }, known, NOW).startsAt, iso(NOW + HOUR));
});

test('makeSale refuses bad input', () => {
  const known = ['core'];
  const bad = [
    [{ target: 'nope', days: 1, percent: 10 }, /Unknown era nope/],
    [{ target: 'core', days: 0, percent: 10 }, /Days/],
    [{ target: 'core', days: 400, percent: 10 }, /Days/],
    [{ target: 'core', days: 1, percent: 91 }, /Percent/],
    [{ target: 'core', days: 1, percent: 2.5 }, /Percent/],
    [{ target: 'core', days: 1, percent: 10, starts: 'tomorrow' }, /--starts/],
    [{ target: 'core', days: 1, percent: 10, starts: iso(NOW - HOUR) }, /past/],
    [{ target: 'core', days: 1, percent: 10, label: ' ' }, /--label/],
  ];
  for (const [opts, msg] of bad) assert.throws(() => makeSale(opts, known, NOW), msg);
});

test('addSale and endSale drop ended sales; endSale refuses unknown ids', () => {
  const ended = sale({ id: 'old', startsAt: iso(NOW - 2 * HOUR), endsAt: iso(NOW - HOUR) });
  const list = addSale([ended, sale()], sale({ id: 's2' }), NOW);
  assert.deepEqual(list.map(s => s.id), ['s1', 's2']);
  assert.deepEqual(endSale(list, 's1', NOW).map(s => s.id), ['s2']);
  assert.deepEqual(endSale(list, 'all', NOW), []);
  assert.throws(() => endSale(list, 'zzz', NOW), /No running or scheduled sale/);
});
