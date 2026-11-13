import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, call, callWithoutData, seedFromFixture, putStock, stockOf, captureLogs } from './helpers/fake-env.mjs';
import { signIn, ADMIN_TOKEN } from './helpers/staff.mjs';
import { REV_KEY, ERA_ORDER_KEY } from '../server/lib/catalog-store.js';
import { productHistory, saveProduct } from '../server/lib/catalog-save.js';
import { adjKey } from '../server/lib/stock.js';
import { NOW } from './helpers/fixture.mjs';

const setup = async (role = 'owner') => {
  const env = makeEnv({ ADMIN_TOKEN });
  await seedFromFixture(env);
  return { env, cookie: await signIn(env, role) };
};
// As the page sends it, against the KV catalog.
const req = (env, cookie, method, path, body) => callWithoutData(method, path, { env, body, headers: { cookie, origin: 'https://api.test' } });
const admin = (env, method, body) => call(method, '/api/admin/eras', { env, body, headers: { Authorization: `Bearer ${ADMIN_TOKEN}` } });
const load = async (env, cookie, id = 'alpha-tee') => (await req(env, cookie, 'GET', `/api/inventory/products/${id}`)).json;
const save = (env, cookie, product, version, extra = {}) => req(env, cookie, 'PUT', `/api/inventory/products/${product.id}`, { opId: crypto.randomUUID(), product, version, ...extra });
// Loads a product, edits a copy, and saves it with the version it was loaded at.
async function edit(env, cookie, fn, extra, id = 'alpha-tee') {
  const { product, version } = await load(env, cookie, id);
  const p = structuredClone(product);
  fn(p);
  return save(env, cookie, p, version, extra);
}
const errorsOf = r => [r.status, r.json.error.code, [...r.json.error.errors].sort()];
const edits = (env, id = 'alpha-tee') => [...env.ORDERS.store].filter(([k]) => k.startsWith(`adj:${id}:`)).map(([, v]) => JSON.parse(v.value)).filter(a => a.reason === 'edit');
const ref = n => ({ id: String(n).padStart(24, '0'), width: 960, height: 1200, widths: [480, 960], ext: 'webp' });
const snapshot = env => JSON.stringify([...env.ORDERS.store].map(([k, v]) => [k, v.value]));
const stockDocOf = (env, id = 'alpha-tee') => JSON.parse(env.ORDERS.store.get(`stock:${id}`)?.value ?? 'null');
const reasons = env => [...env.ORDERS.store].filter(([k]) => k.startsWith('adj:')).map(([, v]) => JSON.parse(v.value).reason);
const ZERO = { onHand: 0, committed: 0 };
// Commits `change` the first time a request reads alpha-tee's stock document: after it loaded the catalog.
function midRequest(env, change) {
  const real = env.ORDERS.getEntry.bind(env.ORDERS);
  let armed = true;
  env.ORDERS.getEntry = async k => { if (armed && k === 'stock:alpha-tee') { armed = false; await change(); } return real(k); };
}
// Renames alpha-tee's White to Bone, straight through saveProduct.
async function renameWhite(env) {
  const { value, version } = await env.ORDERS.getEntry('product:alpha-tee');
  const product = JSON.parse(value);
  product.colors[1].name = 'Bone';
  const r = await saveProduct(env, { opId: crypto.randomUUID(), product, renames: { White: 'Bone' }, version, by: 'other@evincus.shop', now: new Date(NOW) });
  assert.equal(r.product.colors[1].name, 'Bone');
}
// Records each commit's check and put keys.
function spy(env) {
  const real = env.ORDERS.commit.bind(env.ORDERS);
  const seen = [];
  env.ORDERS.commit = async o => { seen.push({ checks: o.checks.map(c => c.key), puts: o.puts.map(p => p.key) }); return real(o); };
  return seen;
}
const draft = over => ({ id: 'alpha-cap', era: 'alpha', status: 'draft', name: '', fabric: '', category: 'tees', priceCents: null, costCents: 0, sizes: [], colors: [], skus: {}, continueSelling: false, lowStockAt: 3, ...over });

test('a stale product save is 409 product-changed with the current product, and nothing changes', async () => {
  const { env, cookie } = await setup();
  const { product, version } = await load(env, cookie);
  assert.equal((await save(env, cookie, { ...product, name: 'First' }, version)).status, 200);
  const before = snapshot(env);
  const r = await save(env, cookie, { ...product, name: 'Second' }, version);
  assert.deepEqual([r.status, r.json.error.code, r.json.error.current.name], [409, 'product-changed', 'First']);
  assert.equal(r.json.error.version, (await load(env, cookie)).version);
  assert.equal(snapshot(env), before);
});

test('colour and size names with |, empty, or over 100 characters are refused', async () => {
  const { env, cookie } = await setup();
  const cases = [
    [p => { p.colors[1].name = 'Wh|te'; }, 'color-invalid'],
    [p => { p.colors[1].name = '   '; }, 'color-invalid'],
    [p => { p.colors[1].name = 'x'.repeat(101); }, 'color-invalid'],
    [p => { p.colors[1].name = 5; }, 'color-invalid'],
    [p => { p.colors[1].name = ' Black, white print '; }, 'color-duplicate'],
    [p => { p.colors[0].hex = '#12345'; }, 'hex-invalid'],
    [p => { p.colors[0].ring = 'red'; }, 'hex-invalid'],
    [p => { p.sizes.push('M|L'); }, 'size-invalid'],
    [p => { p.sizes.push(''); }, 'size-invalid'],
    [p => { p.sizes.push('L'.repeat(101)); }, 'size-invalid'],
    [p => { p.sizes.push(' M'); }, 'size-duplicate'],
    [p => { p.colors[0].images[0] = { ...p.colors[0].images[0], id: '../../etc' }; }, 'photo-invalid'],
  ];
  for (const [fn, code] of cases) {
    const r = await edit(env, cookie, fn);
    assert.deepEqual([r.status, r.json.error.code], [400, 'invalid-product'], code);
    assert.ok(r.json.error.errors.includes(code), `${code}: ${r.json.error.errors}`);
  }
  const ok = await edit(env, cookie, p => { p.sizes.push(` ${'L'.repeat(100)} `); p.colors[0].ring = '#B3262B'; });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json.product.sizes, ['S', 'M', 'L'.repeat(100)]);
  assert.deepEqual(stockOf(env, `alpha-tee|White|${'L'.repeat(100)}`), ZERO); // new variants get zero rows
  assert.equal(Object.keys(stockDocOf(env)).length, 6);
  assert.equal(ok.json.product.colors[0].ring, '#B3262B');
});

test('renaming a colour moves its stock keys and SKUs in one commit; refused while committed > 0', async () => {
  const { env, cookie } = await setup();
  const { skus } = (await edit(env, cookie, () => {})).json.product; // the first save fills default SKUs
  assert.equal(skus['White|S'], 'ALPHA-TEE-WHT-S');
  const rename = p => { p.colors[1].name = ' Bone '; };
  const guessed = await edit(env, cookie, rename); // no mapping: a removed colour plus a new one, never a guess
  assert.deepEqual(errorsOf(guessed), [400, 'invalid-product', ['color-has-stock']]);
  putStock(env, 'alpha-tee|White|S', 4, 1);
  const no = await edit(env, cookie, rename, { renames: { White: 'Bone' } });
  assert.deepEqual(errorsOf(no), [400, 'invalid-product', ['color-committed']]);
  putStock(env, 'alpha-tee|White|S', 4, 0);
  const bad = await edit(env, cookie, rename, { renames: { Ghost: 'Bone' } });
  assert.deepEqual(errorsOf(bad), [400, 'invalid-product', ['color-has-stock', 'rename-invalid']]);
  const seen = spy(env);
  const ok = await edit(env, cookie, rename, { renames: { White: ' Bone ' } });
  assert.equal(ok.status, 200);
  assert.equal(seen.length, 1);
  assert.ok(seen[0].puts.includes('product:alpha-tee') && seen[0].puts.includes('stock:alpha-tee'));
  assert.deepEqual(stockOf(env, 'alpha-tee|Bone|S'), { onHand: 4, committed: 0 });
  assert.deepEqual(stockOf(env, 'alpha-tee|Bone|M'), { onHand: 0, committed: 0 });
  assert.equal(stockOf(env, 'alpha-tee|White|S'), undefined);
  assert.deepEqual(stockOf(env, 'alpha-tee|Black, white print|S'), { onHand: 10, committed: 0 });
  assert.equal(ok.json.product.skus['Bone|S'], 'ALPHA-TEE-WHT-S');
  assert.equal(ok.json.product.skus['White|S'], undefined);
  // A swap moves both colours' rows at once.
  const swap = await edit(env, cookie, p => { [p.colors[0].name, p.colors[1].name] = [p.colors[1].name, p.colors[0].name]; }, { renames: { Bone: 'Black, white print', 'Black, white print': 'Bone' } });
  assert.equal(swap.status, 200);
  assert.deepEqual([stockOf(env, 'alpha-tee|Bone|S').onHand, stockOf(env, 'alpha-tee|Black, white print|S').onHand], [10, 4]);
});

test('SKUs follow the stock: a renamed colour keeps its SKUs when a new colour takes its old name in the same save', async () => {
  const { env, cookie } = await setup();
  await edit(env, cookie, () => {}); // fills default SKUs
  putStock(env, 'alpha-tee|White|S', 4, 0);
  const r = await edit(env, cookie, p => { p.colors[1].name = 'Bone'; p.colors.push({ name: 'White', hex: '#FFFFFF' }); p.skus = {}; }, { renames: { White: 'Bone' } });
  assert.equal(r.status, 200);
  assert.deepEqual([r.json.product.skus['Bone|S'], r.json.product.skus['White|S'], r.json.product.skus['Black, white print|S']], ['ALPHA-TEE-WHT-S', 'ALPHA-TEE-WHT-S-2', 'ALPHA-TEE-PRN-S']);
  assert.deepEqual([stockOf(env, 'alpha-tee|Bone|S'), stockOf(env, 'alpha-tee|White|S')], [{ onHand: 4, committed: 0 }, ZERO]);
});

test("a rename committed between an adjustment's catalog load and its stock read fails the adjustment, which writes nothing", async () => {
  const { env, cookie } = await setup();
  midRequest(env, () => renameWhite(env));
  const opId = crypto.randomUUID();
  const r = await req(env, cookie, 'POST', '/api/inventory/stock', { opId, productId: 'alpha-tee', changes: [{ key: 'alpha-tee|White|S', delta: 1 }], reason: 'received' });
  assert.deepEqual([r.status, r.json.error.code, r.json.error.message], [409, 'product-changed', 'This product changed while saving. Reload and try again.']);
  assert.deepEqual([stockOf(env, 'alpha-tee|Bone|S'), stockOf(env, 'alpha-tee|White|S')], [{ onHand: 10, committed: 0 }, undefined]);
  assert.equal(reasons(env).includes('received'), false);
  assert.equal(env.ORDERS.store.has(`op:${opId}`), false);
});

test("a rename committed between a checkout's catalog load and its stock read is bag-changed, and nothing is written", async () => {
  const { env } = await setup();
  midRequest(env, () => renameWhite(env));
  const order = { checkoutToken: crypto.randomUUID(), items: [{ id: 'alpha-tee', color: 'White', size: 'S', qty: 1 }], customer: { firstName: 'Ann', lastName: 'Lee', email: 'ann@example.com', phone: '+1 555 123 4567' }, fulfillment: { type: 'pickup', locationId: 'trendy-hats' }, expectedTotalCents: 4218 };
  const r = await callWithoutData('POST', '/api/orders', { env, body: order });
  assert.deepEqual([r.status, r.json.error.code, r.json.error.lines.map(l => l.status)], [409, 'bag-changed', ['unknown-item']]);
  assert.equal([...env.ORDERS.store.keys()].some(k => /^(order|submission|day|email-retry):/.test(k)), false);
  assert.equal(reasons(env).includes('order'), false);
  assert.deepEqual([stockOf(env, 'alpha-tee|Bone|S'), stockOf(env, 'alpha-tee|White|S')], [{ onHand: 10, committed: 0 }, undefined]);
});

test('an opId reused on another endpoint is 409 op-reused and applies nothing', async () => {
  const { env, cookie } = await setup();
  const opId = crypto.randomUUID();
  const adjust = id => req(env, cookie, 'POST', '/api/inventory/stock', { opId: id, productId: 'alpha-tee', changes: [{ key: 'alpha-tee|White|S', delta: 1 }], reason: 'received' });
  assert.equal((await adjust(opId)).status, 200);
  const { product, version } = await load(env, cookie);
  const g = (await req(env, cookie, 'GET', '/api/inventory/eras')).json;
  const before = snapshot(env);
  for (const [path, body] of [
    ['/api/inventory/products/alpha-tee', { opId, product: { ...product, name: 'X' }, version }],
    ['/api/inventory/eras/alpha', { opId, era: { ...g.eras[1].era, name: 'X' }, version: g.eras[1].version }],
    ['/api/inventory/era-order', { opId, order: [...g.order].reverse(), version: g.version }],
  ]) {
    const r = await req(env, cookie, 'PUT', path, body);
    assert.deepEqual([r.status, r.json.error.code, r.json.error.message], [409, 'op-reused', 'That request ID was already used for something else. Reload and try again.'], path);
  }
  assert.equal(snapshot(env), before);
  const other = crypto.randomUUID();
  assert.equal((await req(env, cookie, 'PUT', '/api/inventory/products/alpha-tee', { opId: other, product: { ...product, name: 'Y' }, version })).status, 200);
  const r = await adjust(other);
  assert.deepEqual([r.status, r.json.error.code], [409, 'op-reused']);
  assert.equal(stockOf(env, 'alpha-tee|White|S').onHand, 11);
  assert.equal(JSON.parse(env.ORDERS.store.get(`op:${opId}`).value).kind, 'stock');
});

test('a lost commit retries from fresh reads in saveProduct and setEraOrder, and gives up as catalog-busy', async () => {
  const { env, cookie } = await setup();
  const real = env.ORDERS.commit.bind(env.ORDERS);
  let lose = 1;
  env.ORDERS.commit = async o => (lose > 0 && o.puts.some(p => p.key === REV_KEY) ? (lose--, false) : real(o));
  const r = await edit(env, cookie, p => { p.name = 'Retried'; });
  assert.deepEqual([r.status, r.json.product.name, lose, edits(env).length], [200, 'Retried', 0, 1]);
  const g = (await req(env, cookie, 'GET', '/api/inventory/eras')).json;
  lose = 1;
  const order = [...g.order].reverse();
  const o = await req(env, cookie, 'PUT', '/api/inventory/era-order', { opId: crypto.randomUUID(), order, version: g.version });
  assert.deepEqual([o.status, o.json.order, lose], [200, order, 0]);
  lose = 5;
  const busy = await edit(env, cookie, p => { p.name = 'Busy'; });
  assert.deepEqual([busy.status, busy.json.error.code, lose], [409, 'catalog-busy', 0]);
  assert.equal((await load(env, cookie)).product.name, 'Retried');
});

test('removing a size with stock on hand is refused', async () => {
  const { env, cookie } = await setup();
  const drop = p => { p.sizes = ['S']; };
  assert.deepEqual(errorsOf(await edit(env, cookie, drop)), [400, 'invalid-product', ['size-has-stock']]);
  putStock(env, 'alpha-tee|Black, white print|M', 0, 1);
  assert.deepEqual(errorsOf(await edit(env, cookie, drop)), [400, 'invalid-product', ['size-has-stock']]);
  putStock(env, 'alpha-tee|Black, white print|M', 0, 0);
  const ok = await edit(env, cookie, drop);
  assert.equal(ok.status, 200);
  assert.deepEqual(Object.keys(ok.json.product.skus).sort(), ['Black, white print|S', 'White|S']);
  assert.deepEqual(Object.keys(stockDocOf(env)).sort(), ['Black, white print|S', 'White|S']); // removed rows are dropped
  assert.deepEqual(errorsOf(await edit(env, cookie, p => { p.colors.pop(); })), [400, 'invalid-product', ['color-has-stock']]);
});

test('an active product without a photo is refused; a draft one saves', async () => {
  const { env, cookie } = await setup();
  const strip = p => { delete p.images; p.colors.forEach(c => delete c.images); };
  assert.deepEqual(errorsOf(await edit(env, cookie, strip)), [400, 'invalid-product', ['photo-required']]);
  assert.equal((await edit(env, cookie, p => { strip(p); p.status = 'draft'; })).status, 200);
  assert.equal((await save(env, cookie, draft(), null)).status, 200);
  const bare = await save(env, cookie, draft({ id: 'alpha-bag', status: 'active' }), null);
  assert.deepEqual(errorsOf(bare), [400, 'invalid-product', ['colors-required', 'name-required', 'photo-required', 'price-required', 'sizes-required']]);
  const junk = await save(env, cookie, draft({ id: 'alpha-bag', status: 'live', priceCents: 0, costCents: -1, continueSelling: 'no', lowStockAt: 1.5, era: 'ghost' }), null);
  assert.deepEqual(errorsOf(junk), [400, 'invalid-product', ['continue-selling-invalid', 'cost-invalid', 'era-unknown', 'low-stock-invalid', 'price-invalid', 'status-invalid']]);
  for (const body of [[], 'x', { opId: 'nope', product: draft({ id: 'alpha-bag' }), version: null }, { opId: crypto.randomUUID(), product: 5, version: null }]) {
    const r = await req(env, cookie, 'PUT', '/api/inventory/products/alpha-bag', body);
    assert.deepEqual([r.status, r.json.error.code], [400, 'invalid-product'], JSON.stringify(body));
  }
});

test('product ids are kebab slugs fixed at creation; a new product goes last in its era', async () => {
  const { env, cookie } = await setup();
  for (const id of ['a--b', 'x'.repeat(61), '-a', 'new', 'eras']) { // 'new' and 'eras' are inventory page addresses
    const r = await req(env, cookie, 'PUT', `/api/inventory/products/${id}`, { opId: crypto.randomUUID(), product: draft({ id }), version: null });
    assert.ok(r.json.error.errors.includes('id-invalid'), id);
  }
  const moved = await edit(env, cookie, p => { p.id = 'alpha-tee-2'; }); // PUT /products/alpha-tee-2 with alpha-tee's version
  assert.deepEqual([moved.status, moved.json.error.code, moved.json.error.current], [409, 'product-changed', null]);
  const { product, version } = await load(env, cookie);
  const r = await req(env, cookie, 'PUT', '/api/inventory/products/alpha-tee', { opId: crypto.randomUUID(), product: { ...product, id: 'alpha-tee-2' }, version });
  assert.deepEqual(errorsOf(r), [400, 'invalid-product', ['id-changed']]);
  const made = await save(env, cookie, draft(), null);
  assert.equal(made.json.product.position, 2); // alpha-tee 0, alpha-hood 1
  assert.equal(made.json.product.createdAt, made.json.product.updatedAt);
  const sized = await save(env, cookie, draft({ id: 'alpha-sock', sizes: ['M'], colors: [{ name: 'Black', hex: '#151515' }] }), null);
  assert.equal(sized.status, 200);
  assert.deepEqual(stockDocOf(env, 'alpha-sock'), { 'Black|M': ZERO }); // a new product's stock document lists its variants
  const again = await save(env, cookie, draft({ name: 'Again' }), null);
  assert.deepEqual([again.status, again.json.error.code, again.json.error.current.name], [409, 'product-exists', '']);
  const direct = await saveProduct(env, { opId: crypto.randomUUID(), product: draft({ id: 'alpha-bag' }), version: null, by: 'cli', now: new Date(NOW) }); // id defaults to product.id
  assert.deepEqual([direct.product.id, direct.product.position, direct.created], ['alpha-bag', 4, true]); // after alpha-cap 2, alpha-sock 3
});

test('field edits land in history with a summary', async () => {
  const { env, cookie } = await setup();
  await edit(env, cookie, p => { p.priceCents = 3299; p.status = 'draft'; });
  await edit(env, cookie, p => {
    Object.assign(p, { priceCents: 3499, status: 'active', name: 'B', description: 'Soft', lowStockAt: 5, continueSelling: true });
    p.images.push(ref(77), ref(78));
    p.colors[0].images.shift();
    p.colors[1].hex = '#000000';
  });
  const { history } = await load(env, cookie);
  const save2 = history.items.find(i => i.summary === 'Price 32.99 → 34.99').id;
  const group = id => id.slice(0, id.lastIndexOf(':')); // adj:<id>:<at>:<opId>, one per save
  const last = history.items.filter(i => group(i.id) === group(save2)).map(i => i.summary).sort();
  assert.deepEqual(last, ['Colour swatches edited', 'Description edited', 'Keep selling when out of stock off → on', 'Low stock at 3 → 5', 'Name "Alpha <Tee>" → "B"', 'Photos: 2 added, 1 removed', 'Price 32.99 → 34.99', 'Status draft → active']);
  assert.ok(history.items.every(i => i.reason === 'edit' && i.by === 'owner@evincus.shop' && typeof i.field === 'string'));
  assert.ok(history.items.every(i => /:\d{3}$/.test(i.id)), 'adj: keys end in a 3-digit index, so one save sorts in order');
  assert.ok(adjKey('p', 'at', 'op', 10) > adjKey('p', 'at', 'op', 9));
  assert.ok(history.items.some(i => i.summary === 'Price 34.99 → 32.99'));
  assert.equal(edits(env).length, 10);
  const made = await save(env, cookie, draft(), null);
  assert.deepEqual(edits(env, 'alpha-cap').map(e => [e.field, e.summary]), [['created', 'Created as draft']]);
  assert.equal(made.status, 200);
  const one = await productHistory(env, 'alpha-tee', { limit: 4 });
  const two = await productHistory(env, 'alpha-tee', { limit: 4, before: one.next });
  assert.deepEqual([one.items.length, two.items.length], [4, 4]);
  assert.ok(two.items[0].id < one.items[3].id);
  const page = await req(env, cookie, 'GET', `/api/inventory/products/alpha-tee/history?before=${encodeURIComponent(two.next)}`);
  assert.deepEqual([page.json.items.length, page.json.next], [2, null]);
});

test('the product page gets the stored document with refs, version, stock, history and media', async () => {
  const { env, cookie } = await setup();
  const r = await req(env, cookie, 'GET', '/api/inventory/products/alpha-tee');
  assert.equal(r.status, 200);
  const { product, version, stock, history, media } = r.json;
  assert.deepEqual(product.colors[0].images[0], ref(5)); // seedFromFixture numbers photos: 3 heroes, then a0, a1
  assert.deepEqual([product.costCents, typeof version], [1200, 'string']);
  assert.deepEqual(stock['White|M'], { onHand: 0, committed: 0 });
  assert.deepEqual(history, { items: [], next: null });
  assert.deepEqual(media['media/000000000000000000000005-960.webp'], { width: 960, height: 1200, variants: [{ src: 'media/000000000000000000000005-480.webp', width: 480 }, { src: 'media/000000000000000000000005-960.webp', width: 960 }] });
  assert.equal(Object.keys(media).length, 3);
  assert.deepEqual([(await req(env, cookie, 'GET', '/api/inventory/products/ghost')).status], [404]);
});

test('viewers never receive costCents or stock at cost', async () => {
  const env = makeEnv({ ADMIN_TOKEN });
  await seedFromFixture(env);
  const owner = await signIn(env, 'owner');
  const viewer = await signIn(env, 'viewer');
  await edit(env, owner, p => { p.costCents = 1500; });
  const ol = await req(env, owner, 'GET', '/api/inventory/products');
  const tee = ol.json.products.find(p => p.id === 'alpha-tee');
  assert.deepEqual(tee, {
    id: 'alpha-tee', name: 'Alpha <Tee>', era: 'alpha', status: 'active', cover: 'media/000000000000000000000005-960.webp',
    skus: tee.skus, variants: 4, available: 30, onHand: 30, committed: 0, low: true, out: 1, stockCents: 45000,
  });
  assert.equal(tee.skus.length, 4);
  assert.deepEqual(ol.json.totals, { onHand: 50, committed: 0, stockCents: 45000 + 2 * 10 * 1200 });
  const vl = await req(env, viewer, 'GET', '/api/inventory/products');
  assert.equal(vl.status, 200);
  assert.deepEqual(vl.json.totals, { onHand: 50, committed: 0 });
  assert.equal(/stockCents|costCents/.test(vl.text), false);
  const vd = await req(env, viewer, 'GET', '/api/inventory/products/alpha-tee');
  assert.equal(vd.status, 200);
  assert.equal(/costCents|Cost /.test(vd.text), false);
  assert.ok((await req(env, owner, 'GET', '/api/inventory/products/alpha-tee')).text.includes('Cost 12.00 → 15.00'));
  const vh = await req(env, viewer, 'GET', '/api/inventory/products/alpha-tee/history');
  assert.equal(/costCents|Cost /.test(vh.text), false);
  const put = await save(env, viewer, vd.json.product, vd.json.version);
  assert.deepEqual([put.status, put.json.error.code], [403, 'forbidden']);
  assert.equal((await req(env, '', 'GET', '/api/inventory/products')).status, 401);
});

test('saving bumps catalog:rev so the storefront shows the edit on its next request', async () => {
  const { env, cookie } = await setup();
  assert.equal((await callWithoutData('GET', '/api/products/alpha-tee', { env })).json.name, 'Alpha <Tee>');
  const { rev } = await env.ORDERS.get(REV_KEY, 'json');
  const seen = spy(env);
  assert.equal((await edit(env, cookie, p => { p.name = 'Renamed Tee'; })).status, 200);
  assert.notEqual((await env.ORDERS.get(REV_KEY, 'json')).rev, rev);
  assert.ok(seen[0].puts.includes(REV_KEY) && !seen[0].checks.includes(REV_KEY));
  assert.ok(!seen[0].puts.includes('stock:alpha-tee'), 'the variants did not change, so the stock document is not rewritten');
  assert.equal((await callWithoutData('GET', '/api/products/alpha-tee', { env })).json.name, 'Renamed Tee');
});

test('a retried product save applies once and returns the stored product; the commit checks product, stock and op only', async () => {
  const { env, cookie } = await setup();
  const { product, version } = await load(env, cookie);
  const opId = crypto.randomUUID();
  const seen = spy(env);
  const send = name => req(env, cookie, 'PUT', '/api/inventory/products/alpha-tee', { opId, product: { ...product, name }, version });
  const logs = captureLogs();
  let first, again;
  try { first = await send('Once'); again = await send('Twice'); } finally { logs.restore(); }
  assert.equal(first.status, 200);
  assert.equal(again.text, first.text);
  assert.equal(first.json.product.name, 'Once');
  assert.equal(first.json.version, (await load(env, cookie)).version);
  assert.equal(edits(env).length, 1);
  assert.deepEqual(seen.map(s => s.checks), [['product:alpha-tee', 'stock:alpha-tee', `op:${opId}`]]);
  assert.deepEqual(logs.lines.filter(l => l.event === 'product.saved').map(l => [l.product, l.replayed]), [['alpha-tee', false], ['alpha-tee', true]]);
});

test('publishing an era without a hero is refused; new-era creates a draft and refuses an existing slug', async () => {
  const { env, cookie } = await setup();
  const made = await admin(env, 'POST', { slug: 'beta', name: ' Beta ' });
  assert.equal(made.status, 201);
  assert.deepEqual([made.json.era.slug, made.json.era.name, made.json.era.state, made.json.era.hero], ['beta', 'Beta', 'draft', null]);
  const taken = await admin(env, 'POST', { slug: 'beta', name: 'Again' });
  assert.deepEqual([taken.status, taken.json.error.code], [409, 'era-exists']);
  assert.deepEqual([(await admin(env, 'POST', { slug: 'Beta 2', name: 'x' })).json.error.code], ['invalid-era']);
  assert.equal((await call('POST', '/api/admin/eras', { env, body: { slug: 'x', name: 'x' } })).status, 401);
  assert.deepEqual((await admin(env, 'GET')).json.eras, [
    { slug: 'beta', name: 'Beta', state: 'draft' }, { slug: 'future', name: 'Future', state: 'published' },
    { slug: 'alpha', name: 'Alpha', state: 'published' }, { slug: 'old', name: 'Old', state: 'published' },
  ]);
  const list = (await req(env, cookie, 'GET', '/api/inventory/eras')).json;
  assert.deepEqual(list.eras.map(e => [e.era.slug, e.productCount]), [['beta', 0], ['future', 1], ['alpha', 2], ['old', 1]]);
  const beta = list.eras[0];
  const put = (era, version) => req(env, cookie, 'PUT', `/api/inventory/eras/${era.slug}`, { opId: crypto.randomUUID(), era, version });
  const no = await put({ ...beta.era, state: 'published', tagline: 'T', story: 'S' }, beta.version);
  assert.deepEqual(errorsOf(no), [400, 'invalid-era', ['hero-required']]);
  assert.deepEqual(errorsOf(await put({ ...beta.era, state: 'published' }, beta.version)), [400, 'invalid-era', ['hero-required', 'story-required', 'tagline-required']]);
  assert.deepEqual(errorsOf(await put({ ...beta.era, dropsAt: '2026-10-10T17:00:00', endsAt: 'soon' }, beta.version)), [400, 'invalid-era', ['drops-at-invalid', 'ends-at-invalid']]);
  const ok = await put({ ...beta.era, state: 'published', tagline: 'T', story: 'S', hero: ref(9), dropsAt: '2026-10-01T00:00:00-05:00' }, beta.version);
  assert.equal(ok.status, 200);
  const stale = await put({ ...beta.era, name: 'Late' }, beta.version);
  assert.deepEqual([stale.status, stale.json.error.code, stale.json.error.current.state], [409, 'era-changed', 'published']);
  assert.ok((await callWithoutData('GET', '/api/eras', { env })).json.eras.some(e => e.slug === 'beta'));
  const viewer = await signIn(env, 'viewer');
  assert.equal((await req(env, viewer, 'GET', '/api/inventory/eras')).status, 200);
  assert.equal((await req(env, viewer, 'PUT', '/api/inventory/eras/beta', { opId: crypto.randomUUID(), era: ok.json.era, version: ok.json.version })).status, 403);
});

test('the era order has its own key: a reorder survives a later product save, and catalog:rev is never checked', async () => {
  const { env, cookie } = await setup();
  const g = (await req(env, cookie, 'GET', '/api/inventory/eras')).json;
  assert.deepEqual(g.order, ['future', 'alpha', 'old']);
  const seen = spy(env);
  const send = (order, version) => req(env, cookie, 'PUT', '/api/inventory/era-order', { opId: crypto.randomUUID(), order, version });
  const order = ['old', 'alpha', 'future'];
  const r = await send(order, g.version);
  assert.deepEqual([r.status, r.json.order], [200, order]);
  assert.deepEqual([(await send(order, g.version)).json.error.code], ['era-order-changed']);
  for (const bad of [['old', 'alpha'], ['old', 'alpha', 'alpha'], ['old', 'alpha', 'ghost'], 'old', [1, 'alpha', 'future'], ['alpha|future', 'old'], ['alpha', 'future,old']]) {
    assert.deepEqual([(await send(bad, r.json.version)).json.error.code], ['invalid-era-order'], JSON.stringify(bad));
  }
  assert.equal((await edit(env, cookie, p => { p.name = 'X'; })).status, 200);
  assert.deepEqual(await env.ORDERS.get(ERA_ORDER_KEY, 'json'), order);
  assert.deepEqual(Object.keys(await env.ORDERS.get(REV_KEY, 'json')), ['rev']);
  assert.deepEqual((await callWithoutData('GET', '/api/catalog', { env })).json.eras.map(e => e.slug), order);
  assert.ok(seen.every(s => !s.checks.includes(REV_KEY)));
  assert.ok(seen.filter(s => s.puts.includes(ERA_ORDER_KEY)).every(s => s.checks.includes(ERA_ORDER_KEY)));
});

test('data seeded before catalog:era-order keeps its catalog:rev order through saves, a new era and a reorder', async () => {
  const env = makeEnv({ ADMIN_TOKEN });
  await seedFromFixture(env);
  await env.ORDERS.delete(ERA_ORDER_KEY);
  await env.ORDERS.put(REV_KEY, JSON.stringify({ rev: 'legacy', eraOrder: ['old', 'future', 'alpha'] }));
  const cookie = await signIn(env);
  const slugs = async () => (await callWithoutData('GET', '/api/catalog', { env })).json.eras.map(e => e.slug);
  assert.deepEqual(await slugs(), ['old', 'future', 'alpha']);
  assert.equal((await edit(env, cookie, p => { p.name = 'X'; })).status, 200);
  assert.deepEqual(await slugs(), ['old', 'future', 'alpha']);
  assert.deepEqual((await env.ORDERS.get(REV_KEY, 'json')).eraOrder, ['old', 'future', 'alpha']); // carried while it is the only copy
  const g = (await req(env, cookie, 'GET', '/api/inventory/eras')).json;
  assert.deepEqual([g.order, g.version], [['old', 'future', 'alpha'], null]);
  const r = await req(env, cookie, 'PUT', '/api/inventory/era-order', { opId: crypto.randomUUID(), order: ['alpha', 'old', 'future'], version: null });
  assert.deepEqual([r.status, r.json.order], [200, ['alpha', 'old', 'future']]);
  assert.deepEqual(Object.keys(await env.ORDERS.get(REV_KEY, 'json')), ['rev']); // ERA_ORDER_KEY exists now
  assert.deepEqual(await slugs(), ['alpha', 'old', 'future']);
  assert.equal((await admin(env, 'POST', { slug: 'beta', name: 'Beta' })).status, 201);
  assert.deepEqual(await env.ORDERS.get(ERA_ORDER_KEY, 'json'), ['beta', 'alpha', 'old', 'future']);
  assert.equal((await edit(env, cookie, p => { p.name = 'Y'; })).status, 200);
  assert.deepEqual(Object.keys(await env.ORDERS.get(REV_KEY, 'json')), ['rev']);
});

test('an era cannot take the slug new, the address of the create page', async () => {
  const { env, cookie } = await setup();
  const era = { slug: 'new', name: 'New', tagline: '', story: '', hero: null, dropsAt: null, endsAt: null, state: 'draft' };
  const r = await req(env, cookie, 'PUT', '/api/inventory/eras/new', { opId: crypto.randomUUID(), era, version: null });
  assert.deepEqual(errorsOf(r), [400, 'invalid-era', ['slug-invalid']]);
});

test('a sale price must be under the price; saved, it reprices the store with the original struck through', async () => {
  const { env, cookie } = await setup();
  const { product, version } = await load(env, cookie);
  for (const bad of [3499, 4000, 0, 12.5, 'x']) {
    const r = await save(env, cookie, { ...product, salePriceCents: bad }, version);
    assert.deepEqual([r.status, r.json.error.errors], [400, ['sale-price-invalid']], String(bad));
  }
  const r = await save(env, cookie, { ...product, salePriceCents: 2500 }, version);
  assert.equal(r.status, 200);
  assert.equal(r.json.product.salePriceCents, 2500);
  const tee = (await callWithoutData('GET', '/api/products/alpha-tee', { env })).json;
  assert.deepEqual([tee.priceCents, tee.compareAtCents, tee.salePriceCents], [2500, 3499, undefined]);
  const cleared = await save(env, cookie, { ...r.json.product, salePriceCents: null }, r.json.version);
  assert.equal(Object.hasOwn(cleared.json.product, 'salePriceCents'), false);
});

test('JMD prices must be above 0, the JMD sale under the JMD price; saved, the store shows them', async () => {
  const { env, cookie } = await setup();
  const { product, version } = await load(env, cookie);
  for (const [over, code] of [[{ jmdPriceCents: 0 }, 'jmd-price-invalid'], [{ jmdPriceCents: 1.5 }, 'jmd-price-invalid'],
    [{ jmdPriceCents: 500000, jmdSalePriceCents: 500000 }, 'jmd-sale-price-invalid'], [{ jmdSalePriceCents: 400000 }, 'jmd-sale-price-invalid']]) {
    const r = await save(env, cookie, { ...product, ...over }, version);
    assert.deepEqual([r.status, r.json.error.errors], [400, [code]], JSON.stringify(over));
  }
  const r = await save(env, cookie, { ...product, jmdPriceCents: 550000 }, version);
  assert.equal(r.status, 200);
  assert.deepEqual((await callWithoutData('GET', '/api/products/alpha-tee', { env })).json.jmd, { priceCents: 550000 });
});
