// Run: node --test tests/orders.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.PAYPAL_CLIENT_ID = 'id';
process.env.PAYPAL_CLIENT_SECRET = 'secret';
process.env.SHIPPING_USD = '5';

const { priceCart, CartError } = await import('../netlify/functions/lib/pricing.mjs');
const { PRODUCTS } = await import('../data/products.js');
const createOrder = (await import('../netlify/functions/create-order.mjs')).default;
const captureOrder = (await import('../netlify/functions/capture-order.mjs')).default;

const p = PRODUCTS[0];
const item = (over = {}) => ({ id: p.id, color: p.colors[0].name, size: p.sizes[0], qty: 2, ...over });
const post = (url, body) => new Request('http://x' + url, { method: 'POST', body: JSON.stringify(body) });

// Fake PayPal: stores created orders, approves them on demand.
function fakePaypal() {
  const orders = new Map();
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const path = new URL(url).pathname;
    calls.push(`${init.method ?? 'GET'} ${path}`);
    const ok = data => new Response(JSON.stringify(data), { status: 200 });
    if (path === '/v1/oauth2/token') return ok({ access_token: 't' });
    if (path === '/v2/checkout/orders') {
      const id = 'ORDER' + (orders.size + 1) + 'ABCDEFG';
      const order = { id, status: 'APPROVED', ...JSON.parse(init.body) };
      orders.set(id, order);
      return ok({ id });
    }
    const m = path.match(/^\/v2\/checkout\/orders\/(\w+)(\/capture)?$/);
    const order = m && orders.get(m[1]);
    if (!order) return new Response('{}', { status: 404 });
    if (!m[2]) return ok(order);
    const unit = order.purchase_units[0];
    return ok({
      id: order.id,
      status: 'COMPLETED',
      payer: { name: { given_name: 'Ann' }, email_address: 'a@b.c' },
      purchase_units: [{ payments: { captures: [{ amount: unit.amount }] } }],
    });
  };
  return { orders, calls };
}

test('prices from catalog, ignores client price, adds shipping', () => {
  const r = priceCart([{ ...item(), price: 0.01 }]);
  assert.equal(r.subtotal, Math.round(p.price * 100) * 2);
  assert.equal(r.shipping, 500);
  assert.equal(r.total, r.subtotal + 500);
});

test('rejects bad carts', () => {
  for (const bad of [
    null, [], [item({ id: 'nope' })], [item({ size: 'XXXL' })], [item({ color: 'Neon' })],
    [item({ qty: 0 })], [item({ qty: 11 })], [item({ qty: 1.5 })], [item({ qty: '2' })], [item(), item()],
  ]) assert.throws(() => priceCart(bad), CartError);
});

test('create then capture happy path', async () => {
  const { orders } = fakePaypal();
  const res = await createOrder(post('/api/orders', { items: [item()] }));
  assert.equal(res.status, 200);
  const { id } = await res.json();
  const unit = orders.get(id).purchase_units[0];
  assert.equal(unit.amount.value, ((Math.round(p.price * 100) * 2 + 500) / 100).toFixed(2));

  const cap = await captureOrder(post('/api/orders/capture', { orderID: id }));
  assert.equal(cap.status, 200);
  assert.deepEqual(await cap.json(), { id, name: 'Ann', email: 'a@b.c' });
});

test('create rejects invalid cart without calling PayPal', async () => {
  const { calls } = fakePaypal();
  const res = await createOrder(post('/api/orders', { items: [item({ qty: 99 })] }));
  assert.equal(res.status, 400);
  assert.equal(calls.length, 0);
});

test('capture refuses an order not created by this server', async () => {
  const { orders, calls } = fakePaypal();
  orders.set('FOREIGN12345', {
    id: 'FOREIGN12345', status: 'APPROVED',
    purchase_units: [{ custom_id: 'abc.def', amount: { currency_code: 'USD', value: '0.01' } }],
  });
  const res = await captureOrder(post('/api/orders/capture', { orderID: 'FOREIGN12345' }));
  assert.equal(res.status, 400);
  assert.ok(!calls.some(c => c.endsWith('/capture')));
});

test('capture refuses an order whose amount was changed after signing', async () => {
  const { orders, calls } = fakePaypal();
  const { id } = await (await createOrder(post('/api/orders', { items: [item()] }))).json();
  orders.get(id).purchase_units[0].amount.value = '0.01';
  const res = await captureOrder(post('/api/orders/capture', { orderID: id }));
  assert.equal(res.status, 400);
  assert.ok(!calls.some(c => c.endsWith('/capture')));
});

test('capture refuses a replayed tag on an order with different, cheaper contents', async () => {
  const { orders, calls } = fakePaypal();
  const { id } = await (await createOrder(post('/api/orders', { items: [item({ qty: 1 })] }))).json();
  const real = orders.get(id).purchase_units[0];
  // Attacker's own order: same signed tag and total, but a different product at a made-up unit price.
  const other = PRODUCTS.find(x => x.price !== p.price) ?? PRODUCTS[1];
  const total = Number(real.amount.value) - 5;
  orders.set('REPLAY123456', {
    id: 'REPLAY123456', status: 'APPROVED',
    purchase_units: [{
      custom_id: real.custom_id,
      amount: { ...real.amount, breakdown: { ...real.amount.breakdown, item_total: { currency_code: 'USD', value: total.toFixed(2) } } },
      items: [{
        name: other.name, sku: `${other.id}|${other.colors[0].name}|${other.sizes[0]}`, quantity: '1',
        unit_amount: { currency_code: 'USD', value: total.toFixed(2) },
      }],
    }],
  });
  const res = await captureOrder(post('/api/orders/capture', { orderID: 'REPLAY123456' }));
  assert.equal(res.status, 400);
  assert.ok(!calls.some(c => c.endsWith('/capture')));
});

test('capture refuses a legit-total order with a tampered line price', async () => {
  const { orders, calls } = fakePaypal();
  const { id } = await (await createOrder(post('/api/orders', { items: [item()] }))).json();
  orders.get(id).purchase_units[0].items[0].unit_amount.value = '0.01';
  const res = await captureOrder(post('/api/orders/capture', { orderID: id }));
  assert.equal(res.status, 400);
  assert.ok(!calls.some(c => c.endsWith('/capture')));
});

test('capture refuses malformed ids and non-POST', async () => {
  fakePaypal();
  assert.equal((await captureOrder(post('/api/orders/capture', { orderID: '../x' }))).status, 400);
  assert.equal((await captureOrder(new Request('http://x/api/orders/capture'))).status, 405);
});
