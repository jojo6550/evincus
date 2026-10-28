import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { onSignedOut, ApiError } from '../assets/js/inventory-api.js';
import {
  filterProducts, pendingSummary, saveAll, productBody, rekeyDeltas, changedFields, editable, slugify, blankProduct, stockUnconfirmed, forgetStock,
} from '../assets/js/inventory-products.js';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

// Answers each request with the next [status, body] for its method ('lost' drops the connection); records every call.
const stub = replies => {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : undefined });
    const reply = replies[init.method].shift();
    if (reply === 'lost') throw new TypeError('Failed to fetch');
    const [status, body] = reply;
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  };
  return calls;
};
const ok = body => [200, body];
const fail = (status, code, details) => [status, { error: { code, message: `${code}.`, details } }];

const p = {
  id: '99-tee', era: 'core', status: 'active', name: '99 Tee', fabric: 'Cotton', category: 'tees', priceCents: 3499, costCents: 1150,
  sizes: ['M', 'L'], colors: [{ name: 'Classic Black', hex: '#151515' }, { name: 'White', hex: '#f4f4f2' }],
  skus: { 'Classic Black|M': '99-TEE-BLK-M', 'Classic Black|L': '99-TEE-BLK-L', 'White|M': '99-TEE-WHT-M', 'White|L': '99-TEE-WHT-L' },
  continueSelling: false, lowStockAt: 3,
};

test('filterProducts matches name and SKU and applies chips', () => {
  const list = [
    { id: 'a', name: '99 Tee', era: 'core', status: 'active', skus: ['99-TEE-BLK-M'], low: false, out: 0 },
    { id: 'b', name: 'Flaming Eye Tee', era: 'core', status: 'active', skus: ['FLM-WHT-2XL'], low: true, out: 0 },
    { id: 'c', name: 'Zip Hoodie', era: 'cat', status: 'active', skus: [], low: true, out: 2 },
    { id: 'd', name: 'Track Jacket', era: 'cat', status: 'draft', skus: [], low: false, out: 0 },
    { id: 'e', name: 'Old Tee', era: 'core', status: 'archived', skus: [], low: true, out: 1 },
  ];
  const ids = opts => filterProducts(list, opts).map(x => x.id);
  assert.deepEqual(ids({}), ['a', 'b', 'c', 'd'], 'All hides archived');
  assert.deepEqual(ids({ q: '  tee ' }), ['a', 'b']);
  assert.deepEqual(ids({ q: 'flm-wht' }), ['b'], 'SKU, any case');
  assert.deepEqual(ids({ chip: 'low' }), ['b', 'c']);
  assert.deepEqual(ids({ chip: 'out' }), ['c']);
  assert.deepEqual(ids({ chip: 'draft' }), ['d']);
  assert.deepEqual(ids({ chip: 'archived' }), ['e']);
  assert.deepEqual(ids({ chip: 'all', era: 'cat' }), ['c', 'd']);
  assert.deepEqual(ids({ chip: 'archived', q: 'old', era: 'core' }), ['e']);
});

test('pendingSummary counts stock changes and units', () => {
  assert.equal(pendingSummary(p, p, { 'Classic Black|M': 6, 'Classic Black|L': 6 }).text, 'Unsaved: 2 stock changes (+12)');
  assert.deepEqual(pendingSummary(p, p, {}), { fields: [], stockChanges: 0, units: 0, text: '' });
  const e = editable(p);
  e.priceCents = 3299;
  e.colors[1].name = 'Lucent White';
  const s = pendingSummary(p, e, { 'White|M': -1, 'White|L': 0 });
  assert.deepEqual(s.fields, ['priceCents', 'colors']);
  assert.equal(s.text, 'Unsaved: price, colours · 1 stock change (−1)');
  assert.deepEqual(pendingSummary(p, editable(p), {}).fields, [], 'an untouched editable copy is clean');
});

test('changedFields ignores row tracking and treats a missing description as empty', () => {
  const e = editable(p);
  e.description = '';
  assert.deepEqual(changedFields(p, e), []);
  assert.deepEqual(changedFields(p, { ...p, sizes: ['M'], lowStockAt: 5 }), ['sizes', 'lowStockAt']);
});

test('productBody sends renames by colour row and moves their SKUs with them', () => {
  const e = editable(p);
  e.colors[0].name = 'White'; // swap the two names
  e.colors[1].name = 'Classic Black';
  e.colors.push({ name: 'Red', hex: '#ff0000', from: null });
  e.sizes = ['M', 'XL'];
  const { product, renames } = productBody(p, e);
  assert.deepEqual(renames, { 'Classic Black': 'White', White: 'Classic Black' });
  assert.deepEqual(product.colors, [{ name: 'White', hex: '#151515' }, { name: 'Classic Black', hex: '#f4f4f2' }, { name: 'Red', hex: '#ff0000' }]);
  assert.deepEqual(product.skus, { 'White|M': '99-TEE-BLK-M', 'Classic Black|M': '99-TEE-WHT-M' }, 'new variants get the default; removed sizes drop');
  assert.equal(productBody(p, editable(p)).renames, undefined);
});

test('typed SKUs live by colour row, follow a rename, and count as a change only when they differ', () => {
  const e = editable(p);
  e.colors[0].name = 'Black';
  assert.ok(!changedFields(p, e).includes('skus'), 'a rename alone is not a SKU edit');
  e.skus['Classic Black|M'] = ' 99-BLACK-M ';
  e.skus['White|L'] = '99-TEE-WHT-L'; // typed back to what it was
  e.colors.push({ name: 'Red', hex: '#ff0000', from: null, tmp: '|1' });
  e.skus['|1|M'] = 'RED-M';
  assert.deepEqual(changedFields(p, e), ['colors', 'skus']);
  const { product } = productBody(p, e);
  assert.deepEqual(product.skus, {
    'Black|M': '99-BLACK-M', 'Black|L': '99-TEE-BLK-L', 'White|M': '99-TEE-WHT-M', 'White|L': '99-TEE-WHT-L', 'Red|M': 'RED-M',
  });
  assert.deepEqual(product.colors.at(-1), { name: 'Red', hex: '#ff0000' });
});

test('slugify makes a product id from a name', () => {
  assert.equal(slugify('  Flaming Eye Tee — 2.0!  '), 'flaming-eye-tee-2-0');
  assert.equal(slugify('Café Noir'), 'cafe-noir');
  assert.equal(slugify('a '.repeat(40)).length <= 60, true);
  assert.doesNotMatch(slugify('ab '.repeat(30)), /-$/);
});

test('a new product is created with version null under its own id', async () => {
  const blank = blankProduct('core');
  assert.equal(blank.status, 'draft');
  const e = editable(blank);
  e.id = 'new-tee';
  e.name = 'New Tee';
  const args = { productId: 'new-tee', original: blank, edited: e, version: null, deltas: {}, reason: 'received', note: '' };
  let calls = stub({ PUT: [fail(409, 'product-exists')] });
  assert.equal((await saveAll(args)).product.code, 'product-exists');
  assert.equal(calls[0].url, '/api/inventory/products/new-tee');
  assert.equal(calls[0].body.version, null);
  assert.equal(calls[0].body.product.id, 'new-tee');
  calls = stub({ PUT: [ok({ product: {}, version: 'v1' })] });
  assert.deepEqual(await saveAll({ ...args, edited: { ...e, id: 'new-tee-2' }, productId: 'new-tee-2' }), { product: 'ok' });
  assert.equal(calls[0].url, '/api/inventory/products/new-tee-2');
});

test('a stock save with no reply locks its edits until it is retried as-is or the stock is reloaded', async () => {
  const id = 'lost-tee';
  const e = editable({ ...p, id });
  e.name = 'Renamed';
  const args = { productId: id, original: { ...p, id }, edited: e, version: 'v1', deltas: { 'White|M': 6 }, reason: 'received', note: '' };
  let calls = stub({ POST: ['lost'] });
  const first = await saveAll(args);
  assert.equal(first.stock.status, 0);
  assert.equal(first.product.code, 'stock-unconfirmed', 'details wait: a rename would move the keys the lost save used');
  assert.equal(calls.length, 1);
  assert.equal(stockUnconfirmed(id), true);
  const op = calls[0].body.opId;

  calls = stub({});
  const changed = await saveAll({ ...args, deltas: { 'White|M': 7 } });
  assert.equal(calls.length, 0, 'different edits are never sent while the lost save is unresolved');
  assert.equal(changed.stock.code, 'stock-unconfirmed');

  calls = stub({ POST: [ok({ stock: {} })], PUT: [ok({ product: {}, version: 'v2' })] });
  assert.deepEqual(await saveAll(args), { stock: 'ok', product: 'ok' });
  assert.equal(calls[0].body.opId, op, 'Retry resends the same op');
  assert.equal(stockUnconfirmed(id), false);

  calls = stub({ POST: ['lost'] });
  await saveAll({ ...args, edited: args.original });
  const lostOp = calls[0].body.opId;
  forgetStock(id); // Reload stock
  assert.equal(stockUnconfirmed(id), false);
  calls = stub({ POST: [ok({ stock: {} })] });
  await saveAll({ ...args, edited: args.original });
  assert.notEqual(calls[0].body.opId, lostOp, 'after a reload the same edits are a new op');
});

test('rekeyDeltas follows renamed colours, swaps included', () => {
  assert.deepEqual(rekeyDeltas({ 'A|M': 1, 'B|M': 2, 'C|L': 3 }, { A: 'B', B: 'A' }), { 'B|M': 1, 'A|M': 2, 'C|L': 3 });
});

test('saveAll reuses its opIds on retry and reports product and stock results separately', async () => {
  const e = editable(p);
  e.name = '99 Tee v2';
  const args = { productId: p.id, original: p, edited: e, version: 'v1', deltas: { 'Classic Black|M': 6 }, reason: 'received', note: 'box 3' };
  let calls = stub({ POST: [fail(409, 'stock-busy')], PUT: [fail(409, 'catalog-busy')] });
  const first = await saveAll(args);
  assert.ok(first.stock instanceof ApiError && first.product instanceof ApiError);
  assert.deepEqual(calls.map(c => c.method), ['POST', 'PUT'], 'stock goes first, while its keys still carry the old colour names');
  const [stockOp, productOp] = calls.map(c => c.body.opId);
  assert.notEqual(stockOp, productOp);
  assert.deepEqual(calls[0].body, { productId: '99-tee', changes: [{ key: '99-tee|Classic Black|M', delta: 6 }], reason: 'received', note: 'box 3', opId: stockOp });
  assert.equal(calls[1].url, '/api/inventory/products/99-tee');
  assert.equal(calls[1].body.version, 'v1');

  calls = stub({ POST: [fail(409, 'stock-below-committed', { key: '99-tee|Classic Black|M' })], PUT: [ok({ product: {}, version: 'v2' })] });
  const second = await saveAll(args);
  assert.deepEqual(calls.map(c => c.body.opId), [stockOp, productOp], 'same press payload, same opIds');
  assert.equal(second.product, 'ok');
  assert.equal(second.stock.code, 'stock-below-committed');
  assert.equal(second.stock.details.key, '99-tee|Classic Black|M');

  calls = stub({ POST: [ok({ stock: {} })], PUT: [ok({ product: {}, version: 'v3' })] });
  assert.deepEqual(await saveAll({ ...args, edited: p }), { stock: 'ok' }, 'no product edits, no product request');
  assert.equal(calls[0].body.opId, stockOp);
  calls = stub({ POST: [ok({ stock: {} })] });
  await saveAll({ ...args, edited: p });
  assert.notEqual(calls[0].body.opId, stockOp, 'after it lands, the same change again is a new op');
});

test('after signed-out and login, saveAll still has the edits and succeeds', async () => {
  const e = editable(p);
  e.priceCents = 3999;
  const args = { productId: p.id, original: p, edited: e, version: 'v1', deltas: { 'White|L': -2 }, reason: 'damaged', note: '' };
  let signedOut = 0;
  const off = onSignedOut(() => signedOut++);
  let calls = stub({ POST: [fail(401, 'signed-out')], PUT: [fail(401, 'signed-out')] });
  const first = await saveAll(args);
  assert.equal(first.stock.code, 'signed-out');
  assert.equal(first.product.code, 'signed-out');
  assert.equal(signedOut, 2);
  const ops = calls.map(c => c.body.opId);

  calls = stub({ POST: [ok({ stock: {} })], PUT: [ok({ product: {}, version: 'v2' })] });
  assert.deepEqual(await saveAll(args), { stock: 'ok', product: 'ok' });
  assert.deepEqual(calls.map(c => c.body.opId), ops);
  assert.equal(calls[1].body.product.priceCents, 3999);
  assert.deepEqual(calls[0].body.changes, [{ key: '99-tee|White|L', delta: -2 }]);
  off();
});
