import test from 'node:test';
import assert from 'node:assert/strict';
import { call, makeEnv, fakeUpstreams, makeCtx, fakeLimiter } from './helpers/fake-env.mjs';
import { createApp } from '../worker/src/index.js';
import { FIXTURE, NOW } from './helpers/fixture.mjs';

const envForOrders = over => makeEnv({ PAYMENT_MODE: 'none', ...over });
const body = () => ({ checkoutToken: crypto.randomUUID(), items: [{ id: 'alpha-tee', color: 'Black, white print', size: 'S', qty: 2 }], customer: { name: 'Ann Lee', email: 'ann@example.com', phone: '+1 555 123 4567' }, fulfillment: { type: 'delivery', address: { address_line_1: '1 Main St', admin_area_2: 'Toronto', admin_area_1: 'Ontario', postal_code: 'M5V 1A1', country_code: 'CA' } }, notes: '<please pack carefully>', expectedTotalCents: 7498 });
const place = (b, env) => call('POST', '/api/orders', { body: b, env });
async function cron(env, iso) {
  const ctx = makeCtx();
  await createApp({ data: FIXTURE, clock: () => Date.parse(iso) }).scheduled({}, env, ctx);
  await ctx.settle();
}

test('direct delivery stores an unpaid order and confirms by Resend without PayPal', async () => {
  const up = fakeUpstreams();
  const env = envForOrders();
  const r = await place(body(), env);
  assert.equal(r.status, 201);
  assert.equal(r.json.paymentStatus, 'NOT_COLLECTED');
  const record = await env.ORDERS.get(`order:${r.json.id}`, 'json');
  assert.equal(record.status, 'PLACED');
  assert.equal(record.totalCents, 7498);
  assert.equal(record.fulfillment.address.country_code, 'CA');
  assert.equal(up.calls.some(c => c.host.includes('paypal')), false);
  assert.equal(up.emails.length, 1);
  assert.match(up.emails[0].html, /No payment was collected/);
  assert.equal(env.ORDERS.store.has(`email-retry:${r.json.id}`), false);
});

test('both pickup locations need no delivery address and have zero shipping', async () => {
  fakeUpstreams();
  for (const locationId of ['trendy-hats', 'evincus-store']) {
    const env = envForOrders();
    const b = { ...body(), fulfillment: { type: 'pickup', locationId }, expectedTotalCents: 6998 };
    const r = await place(b, env);
    assert.equal(r.status, 201);
    const record = await env.ORDERS.get(`order:${r.json.id}`, 'json');
    assert.equal(record.shippingCents, 0);
    assert.equal(record.fulfillment.location.id, locationId);
    assert.equal(record.fulfillment.location.address, null);
  }
});

test('invalid contact, address, pickup and unsupported countries do not save orders', async () => {
  fakeUpstreams();
  for (const modify of [b => { b.customer.email = 'bad'; }, b => { b.customer.phone = 'abc'; }, b => { b.fulfillment.address.address_line_1 = ''; }, b => { b.fulfillment.address.postal_code = ''; }, b => { b.fulfillment.address.country_code = 'XX'; }, b => { b.fulfillment = { type: 'pickup', locationId: 'made-up' }; }]) {
    const env = envForOrders(); const b = body(); modify(b);
    assert.equal((await place(b, env)).status, 400);
    assert.equal([...env.ORDERS.store.keys()].filter(k => k.startsWith('order:')).length, 0);
  }
  assert.equal((await place(body(), envForOrders({ DELIVERY_EXCLUDED_COUNTRIES: 'CA' }))).json.error.code, 'unsupported-country');
});

test('USA and Canada are offered and excluded countries disappear from checkout', async () => {
  const r = await call('GET', '/api/checkout/options', { env: envForOrders({ DELIVERY_EXCLUDED_COUNTRIES: 'AQ' }) });
  assert.ok(r.json.countries.includes('US'));
  assert.ok(r.json.countries.includes('CA'));
  assert.ok(!r.json.countries.includes('AQ'));
  assert.equal(r.json.pickupLocations.length, 2);
});

test('server rejects tampered totals and unavailable or excessive quantities', async () => {
  fakeUpstreams();
  for (const modify of [b => { b.expectedTotalCents = 1; }, b => { b.items[0].qty = 11; }, b => { b.items[0].color = 'White'; b.items[0].size = 'M'; }]) {
    const b = body(); modify(b);
    assert.equal((await place(b, envForOrders())).status, 409);
  }
});

test('concurrent submissions and later retries create one order and preserve its original time', async () => {
  fakeUpstreams();
  const env = envForOrders(); const b = body();
  const responses = await Promise.all([place(b, env), place(b, env)]);
  assert.ok(responses.every(r => r.status === 201));
  assert.equal(responses[0].json.id, responses[1].json.id);
  assert.equal([...env.ORDERS.store.keys()].filter(k => k.startsWith('order:')).length, 1);
  const changedCatalog = structuredClone(FIXTURE);
  changedCatalog.products[0].soldOut = true;
  const retry = await call('POST', '/api/orders', { body: b, env, clock: () => NOW + 86400000, data: changedCatalog });
  assert.equal(retry.status, 201);
  assert.equal((await env.ORDERS.get(`order:${retry.json.id}`, 'json')).placedAt, new Date(NOW).toISOString());
  assert.equal((await place({ ...b, notes: 'different' }, env)).json.error.code, 'checkout-conflict');
});

test('storage failure never acknowledges an order and retry repairs its index', async () => {
  fakeUpstreams(); const env = envForOrders(); const b = body();
  env.ORDERS.failPuts = key => key.startsWith('day:');
  assert.equal((await place(b, env)).status, 500);
  env.ORDERS.failPuts = null;
  const r = await place(b, env);
  assert.equal(r.status, 201);
  assert.ok(env.ORDERS.store.has(`day:2026-10-03:${r.json.id}`));
});

test('failed confirmation is queued and retried without losing the order', async () => {
  let fail = true;
  const up = fakeUpstreams({ resend: { fail: () => fail } });
  const env = envForOrders(); const r = await place(body(), env);
  assert.equal(r.status, 201);
  assert.ok(env.ORDERS.store.has(`email-retry:${r.json.id}`));
  fail = false;
  await cron(env, '2026-10-03T12:15:00Z');
  assert.equal(up.emails.length, 1);
  assert.equal(env.ORDERS.store.has(`email-retry:${r.json.id}`), false);
});

test('daily digest waits for 8am Jamaica, includes orders, escapes notes, and sends only once', async () => {
  const up = fakeUpstreams(); const env = envForOrders();
  await place(body(), env);
  await cron(env, '2026-10-04T12:45:00Z');
  assert.equal(up.emails.length, 1);
  await cron(env, '2026-10-04T13:00:00Z');
  const digest = up.emails.find(e => e.to[0] === env.OWNER_EMAIL);
  assert.match(digest.subject, /2026-10-03 \(1 orders\)/);
  assert.ok(digest.html.includes('ann@example.com'));
  assert.ok(digest.html.includes('&lt;please pack carefully&gt;'));
  assert.ok(!digest.html.includes('<please pack carefully>'));
  assert.ok(digest.html.includes('no payment collected'));
  await cron(env, '2026-10-04T13:15:00Z');
  assert.equal(up.emails.length, 2);
});

test('daily digest failures retry with stable content and idempotency key', async () => {
  let fail = true;
  const up = fakeUpstreams({ resend: { fail: b => fail && b.to[0] === 'owner@evincus.shop' } });
  const env = envForOrders(); await place(body(), env);
  await cron(env, '2026-10-04T13:00:00Z');
  const job = await env.ORDERS.get('digest-pending:2026-10-03', 'json');
  assert.equal(job.parts[0].sent, false);
  fail = false;
  await cron(env, '2026-10-04T13:15:00Z');
  assert.equal(up.emails[1].html, job.parts[0].html);
  assert.equal(up.emails[1].idempotencyKey, 'daily-orders-2026-10-03-0');
  assert.equal(await env.ORDERS.get('digest-pending:2026-10-03'), null);
});

test('orders around midnight use the Jamaica day and payment capture is disabled', async () => {
  fakeUpstreams(); const env = envForOrders();
  const r = await call('POST', '/api/orders', { body: body(), env, clock: () => Date.parse('2026-10-04T04:59:00Z') });
  assert.ok(env.ORDERS.store.has(`day:2026-10-03:${r.json.id}`));
  assert.equal((await call('POST', '/api/orders/capture', { body: {}, env })).status, 403);
});

test('order rate limiting prevents excess submissions', async () => {
  fakeUpstreams();
  const env = envForOrders({ ORDER_LIMIT: fakeLimiter(1) });
  assert.equal((await place(body(), env)).status, 201);
  assert.equal((await place(body(), env)).status, 429);
});

test('daily digest reports an empty day and splits large days into stable parts', async () => {
  const up = fakeUpstreams();
  const empty = envForOrders();
  await cron(empty, '2026-10-04T13:00:00Z');
  assert.match(up.emails[0].html, /No orders today/);
  const env = envForOrders();
  const placed = await place(body(), env);
  const record = await env.ORDERS.get(`order:${placed.json.id}`, 'json');
  for (let i = 0; i < 21; i++) {
    const id = `extra-${i}`;
    await env.ORDERS.put(`order:${id}`, JSON.stringify({ ...record, id }));
    await env.ORDERS.put(`day:2026-10-03:${id}`, '');
  }
  await cron(env, '2026-10-04T13:00:00Z');
  const parts = up.emails.filter(e => e.subject.includes('(22 orders)'));
  assert.equal(parts.length, 2);
  assert.equal((parts[0].html.match(/<h2>/g) ?? []).length, 20);
  assert.equal((parts[1].html.match(/<h2>/g) ?? []).length, 2);
});

test('daily summaries catch up after missed cron days', async () => {
  const up = fakeUpstreams(); const env = envForOrders();
  await cron(env, '2026-10-04T13:00:00Z');
  await cron(env, '2026-10-07T13:00:00Z');
  assert.equal(up.emails.length, 4);
  for (const day of ['2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06']) assert.ok(up.emails.some(e => e.subject.includes(day)));
});
