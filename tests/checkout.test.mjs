import test from 'node:test';
import assert from 'node:assert/strict';
import { call, makeEnv, fakeUpstreams, makeCtx, fakeLimiter, putStock, stockOf, captureLogs } from './helpers/fake-env.mjs';
import { charges } from '../data/fees.js';
import { createApp } from '../server/index.js';
import { revealOrder } from '../server/lib/orders.js';
import { sendOrderEmails } from '../server/lib/delivery.js';
import { COUNTRIES } from '../data/countries.js';
import { unseal } from '../server/lib/crypto.js';
import { WIPAY, payOrder } from './helpers/pay.mjs';
import { FIXTURE, NOW, fixtureStock } from './helpers/fixture.mjs';

const envForOrders = (over = {}) => makeEnv({ ...WIPAY, ...over });
const body = () => ({ checkoutToken: crypto.randomUUID(), items: [{ id: 'alpha-tee', color: 'Black, white print', size: 'S', qty: 2 }], customer: { firstName: 'Ann', lastName: 'Lee', email: 'ann@example.com', phone: '+1 555 123 4567' }, fulfillment: { type: 'pickup', locationId: 'trendy-hats' }, notes: '<please pack carefully>', expectedTotalCents: 8437 });
const place = (b, env, data) => call('POST', '/api/orders', { body: b, env, data });
const oneUnit = () => ({ ...body(), items: [{ ...body().items[0], qty: 1 }], expectedTotalCents: 4218 });
const SHIRT = 'alpha-tee|Black, white print|S';
// The fixture catalog with alpha-tee changed; the app applies stock from env.ORDERS on top.
const withTee = over => ({ ...FIXTURE, products: FIXTURE.products.map(p => (p.id === 'alpha-tee' ? { ...p, ...over } : p)) });
async function cron(env, iso) {
  const ctx = makeCtx();
  await createApp({ data: FIXTURE, clock: () => Date.parse(iso) }).scheduled({}, env, ctx);
  await ctx.settle();
}

const ship = (address = {}) => ({ ...body(), fulfillment: { type: 'shipping', address: { line1: '1 Main St', city: 'Toronto', country: 'CA', ...address } } });
const stored = (env, id) => env.ORDERS.store.get(`order:${id}`).value;

test('a placed order awaits payment, is sealed and held, and sends nothing', async () => {
  const up = fakeUpstreams();
  const env = envForOrders();
  const r = await place(body(), env);
  assert.equal(r.status, 201);
  assert.deepEqual(r.json, { id: r.json.id, status: 'AWAITING_PAYMENT', paymentStatus: 'UNPAID', fulfillment: { type: 'pickup' }, totalCents: 8437 });
  const record = await env.ORDERS.get(`order:${r.json.id}`, 'json');
  assert.equal(record.status, 'AWAITING_PAYMENT');
  assert.deepEqual([record.subtotalCents, record.taxCents, record.feeCents, record.taxBps, record.feeBps, record.totalCents], [6998, 1050, 389, 1500, 483, 8437]);
  assert.equal(record.fulfillment.location.id, 'trendy-hats');
  assert.equal(record.stockCommitted, true);
  assert.equal(record.fulfilmentStatus, 'UNFULFILLED');
  assert.equal(record.holdUntil, new Date(NOW + 900000).toISOString());
  assert.deepEqual(record.events, [{ at: new Date(NOW).toISOString(), type: 'placed', by: null }]);
  assert.equal(up.emails.length, 0);
  const keys = [...env.ORDERS.store.keys()];
  assert.equal(keys.filter(k => k.startsWith('email-retry:')).length, 0);
  assert.deepEqual(keys.filter(k => k.startsWith('hold:')), [`hold:${String(NOW + 900000).padStart(13, '0')}:${r.json.id}`]);
  assert.equal(keys.filter(k => k.startsWith('adj:')).length, 1);
  assert.equal(stockOf(env, SHIRT).committed, 2);
  const day = env.ORDERS.store.get(`day:2026-10-03:${r.json.id}`);
  assert.equal(day.opts.metadata.payment, 'UNPAID');
  assert.equal(day.opts.expirationTtl, undefined);
  assert.equal(env.ORDERS.store.get(`order:${r.json.id}`).opts.expirationTtl, undefined);
  assert.equal(env.ORDERS.store.get(`submission:${r.json.id}`).opts.expirationTtl, 604800);
});

test('customer details are sealed at rest and revealed for the owner', async () => {
  fakeUpstreams();
  const env = envForOrders();
  const r = await place(body(), env);
  for (const secret of ['ann@example.com', '"firstName"', 'please pack', '555 123']) { // none can occur in base64
    assert.ok(!stored(env, r.json.id).includes(secret), secret);
    assert.ok(!env.ORDERS.store.get(`submission:${r.json.id}`).value.includes(secret), secret);
  }
  const record = await env.ORDERS.get(`order:${r.json.id}`, 'json');
  for (const f of ['customer', 'payer', 'notes']) assert.equal(record[f], undefined);
  const shown = await revealOrder(env, record);
  assert.deepEqual(shown.customer, { firstName: 'Ann', lastName: 'Lee', name: 'Ann Lee', email: 'ann@example.com', phone: '+1 555 123 4567' });
  assert.equal(shown.notes, '<please pack carefully>');
  assert.equal(shown.address, null);
});

test('revealOrder reads legacy plaintext orders', async () => {
  const shown = await revealOrder(envForOrders(), { id: 'EV-1', customer: { name: 'Tanya Marie Brown', email: 't@example.com', phone: '5551234567' }, notes: 'hi' });
  assert.deepEqual(shown.customer, { firstName: 'Tanya Marie', lastName: 'Brown', name: 'Tanya Marie Brown', email: 't@example.com', phone: '5551234567' });
  assert.equal(shown.notes, 'hi');
});

test('checkout field rules', async () => {
  fakeUpstreams();
  const ok = async b => (await place(b, envForOrders())).status;
  const bad = async b => (await place(b, envForOrders())).json?.error?.code;
  const local = n => 'a'.repeat(n - '@example.com'.length) + '@example.com';
  const withCustomer = over => { const b = body(); Object.assign(b.customer, over); return b; };
  assert.equal(await ok(withCustomer({ phone: undefined })), 201);
  assert.equal(await bad(withCustomer({ phone: 'abc' })), 'invalid-checkout');
  assert.equal(await ok(withCustomer({ email: local(50) })), 201);
  const long = await place(withCustomer({ email: local(51) }), envForOrders());
  assert.equal(long.json.error.code, 'invalid-checkout');
  assert.match(long.json.error.message, /50 characters max/);
  assert.equal(await bad(withCustomer({ firstName: 'a'.repeat(31) })), 'invalid-checkout');
  assert.equal(await bad(withCustomer({ lastName: '' })), 'invalid-checkout');
  assert.equal(await bad(withCustomer({ lastName: 'Le\u0007e' })), 'invalid-checkout');
  assert.equal(await bad({ ...body(), notes: 'a\u0000b' }), 'invalid-checkout');
  assert.equal(await bad({ ...body(), fulfillment: { type: 'pickup', locationId: 'trendy-hats', address: { line1: '1 Main St' } } }), 'invalid-checkout');
  assert.equal(await bad({ ...body(), fulfillment: { type: 'pickup' } }), 'invalid-checkout');
  assert.equal(await bad(ship({ line1: '' })), 'invalid-checkout');
  assert.equal(await bad(ship({ city: undefined })), 'invalid-checkout');
  assert.equal(await bad(ship({ country: 'XX' })), 'invalid-checkout');
  assert.equal(await bad(ship({ line2: 'x'.repeat(101) })), 'invalid-checkout');
  assert.equal(await bad(ship({ postalCode: 'x'.repeat(21) })), 'invalid-checkout');
});

test('a shipping order keeps its address only in the sealed details', async () => {
  fakeUpstreams();
  const env = envForOrders();
  const r = await place(ship({ region: 'Ontario', postalCode: 'M5V 2T6' }), env);
  assert.equal(r.status, 201);
  assert.deepEqual(r.json.fulfillment, { type: 'shipping' });
  const record = await env.ORDERS.get(`order:${r.json.id}`, 'json');
  assert.deepEqual(record.fulfillment, { type: 'shipping' });
  assert.ok(!stored(env, r.json.id).includes('Main St'));
  assert.deepEqual((await revealOrder(env, record)).address, { line1: '1 Main St', line2: '', city: 'Toronto', region: 'Ontario', postalCode: 'M5V 2T6', country: 'CA' });
});

test('COUNTRIES maps every ISO 3166-1 code to a currency', () => {
  assert.equal(Object.keys(COUNTRIES).length, 249);
  assert.equal(COUNTRIES.JM, 'JMD'); assert.equal(COUNTRIES.US, 'USD'); assert.equal(COUNTRIES.DE, 'EUR');
  assert.ok(Object.entries(COUNTRIES).every(([k, v]) => /^[A-Z]{2}$/.test(k) && /^[A-Z]{3}$/.test(v)));
});

test('customer markup is escaped in receipts and daily summaries', async () => {
  const up = fakeUpstreams();
  const env = envForOrders();
  const b = body(); b.customer.firstName = '<img src=x onerror=alert(1)>'; b.notes = '<script>alert(1)</script>';
  const r = await place(b, env);
  assert.equal(r.status, 201);
  await payOrder(env, r.json.id);
  await cron(env, '2026-10-04T13:00:00Z');
  assert.ok(up.emails.length >= 2);
  for (const email of up.emails) {
    assert.doesNotMatch(email.html, /<script>|<img src=x/);
    assert.match(email.html, /&lt;/);
  }
});

test('both pickup locations place orders', async () => {
  fakeUpstreams();
  for (const locationId of ['trendy-hats', 'evincus-store']) {
    const env = envForOrders();
    const b = { ...body(), fulfillment: { type: 'pickup', locationId } };
    const r = await place(b, env);
    assert.equal(r.status, 201);
    const record = await env.ORDERS.get(`order:${r.json.id}`, 'json');
    assert.equal(record.fulfillment.location.id, locationId);
    assert.equal(record.fulfillment.location.address, null);
  }
});

test('invalid contact, unknown pickup and delivery requests do not save orders', async () => {
  fakeUpstreams();
  for (const modify of [b => { b.customer.email = 'bad'; }, b => { b.customer.phone = 'abc'; }, b => { b.fulfillment = { type: 'pickup', locationId: 'made-up' }; }, b => { b.fulfillment = { type: 'delivery', address: { address_line_1: '1 Main St', admin_area_2: 'Toronto', country_code: 'CA' } }; }]) {
    const env = envForOrders(); const b = body(); modify(b);
    assert.equal((await place(b, env)).json.error.code, 'invalid-checkout');
    assert.equal([...env.ORDERS.store.keys()].filter(k => k.startsWith('order:')).length, 0);
  }
});

test('checkout options offer only the pickup locations', async () => {
  const r = await call('GET', '/api/checkout/options', { env: envForOrders() });
  assert.deepEqual(Object.keys(r.json), ['pickupLocations']);
  assert.equal(r.json.pickupLocations.length, 2);
});

test('server rejects tampered totals and unavailable or excessive quantities', async () => {
  fakeUpstreams();
  for (const modify of [b => { b.expectedTotalCents = 1; }, b => { b.items[0].qty = 11; }, b => { b.items[0].color = 'White'; b.items[0].size = 'M'; }]) {
    const b = body(); modify(b);
    assert.equal((await place(b, envForOrders())).status, 409);
  }
});

test('a pre-fee total (subtotal only) is bag-changed', async () => {
  fakeUpstreams();
  const r = await place({ ...body(), expectedTotalCents: 6998 }, envForOrders());
  assert.equal(r.status, 409);
  assert.equal(r.json.error.code, 'bag-changed');
});

test('concurrent submissions and later retries create one order and preserve its original time', async () => {
  fakeUpstreams();
  const env = envForOrders(); const b = body();
  const responses = await Promise.all([place(b, env), place(b, env)]);
  assert.ok(responses.every(r => r.status === 201));
  assert.equal(responses[0].json.id, responses[1].json.id);
  assert.equal([...env.ORDERS.store.keys()].filter(k => k.startsWith('order:')).length, 1);
  for (const k of fixtureStock().keys()) putStock(env, k, 0); // everything sold out
  const retry = await call('POST', '/api/orders', { body: b, env, clock: () => NOW + 86400000 });
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

test('a failed receipt is queued and retried without losing the order', async () => {
  let fail = true;
  const up = fakeUpstreams({ resend: { fail: () => fail } });
  const env = envForOrders(); const r = await place(body(), env);
  const quiet = { info() {}, warn() {}, error() {} };
  await sendOrderEmails({ env, now: new Date(NOW), log: quiet }, await env.ORDERS.get(`order:${r.json.id}`, 'json'));
  assert.ok(env.ORDERS.store.has(`email-retry:${r.json.id}`));
  fail = false;
  await cron(env, '2026-10-03T12:15:00Z');
  assert.equal(up.emails.filter(e => e.to[0] === 'ann@example.com').length, 1);
  assert.equal(env.ORDERS.store.has(`email-retry:${r.json.id}`), false);
});

const placePaid = async (env, b = body(), clock) => { const r = await place(b, env); await payOrder(env, r.json.id, clock && { clock }); return r.json.id; };
const ownerMails = up => up.emails.filter(e => e.to[0] === 'owner@evincus.shop');
const html = async (env, part) => (part.sealed ? unseal(env, part.sealed) : part.html);

test('daily summary waits for 8am Jamaica, lists paid orders with contact, money and transaction, and sends once', async () => {
  const up = fakeUpstreams(); const env = envForOrders();
  const id = await placePaid(env);
  await cron(env, '2026-10-04T12:45:00Z');
  assert.equal(ownerMails(up).length, 0);
  await cron(env, '2026-10-04T13:00:00Z');
  const [digest] = ownerMails(up);
  assert.match(digest.subject, /2026-10-03 \(1 orders\)/);
  const txn = (await env.ORDERS.get(`order:${id}`, 'json')).payment.transactionId;
  for (const s of ['ann@example.com', 'Ann Lee', '+1 555 123 4567', 'TrendyHatz', txn, 'Subtotal', 'GCT (15%)', 'Processing fee (4.83%, non-refundable)', '$84.37 USD', 'Collected', '&lt;please pack carefully&gt;']) assert.ok(digest.html.includes(s), s);
  assert.ok(!digest.html.includes('<please pack carefully>'));
  assert.ok(!/order value/i.test(digest.html));
  await cron(env, '2026-10-04T13:15:00Z');
  assert.equal(ownerMails(up).length, 1);
});

test('the summary lists orders that reached WiPay but are unpaid, with contact and attempt, and leaves out paid ones', async () => {
  const up = fakeUpstreams(); const env = envForOrders();
  const unpaid = (await place({ ...body(), customer: { ...body().customer, firstName: 'Bo', email: 'bo@example.com' } }, env)).json.id;
  await call('POST', `/api/orders/${unpaid}/pay`, { body: {}, env });
  const neverPaid = (await place({ ...body(), customer: { ...body().customer, firstName: 'Cy', email: 'cy@example.com' } }, env)).json.id; // never reached WiPay
  await placePaid(env);
  await cron(env, '2026-10-04T13:00:00Z');
  const [digest] = ownerMails(up);
  const attemptId = (await env.ORDERS.get(`order:${unpaid}`, 'json')).attemptId;
  const section = digest.html.slice(digest.html.indexOf('Reached WiPay, not paid'));
  assert.ok(section.includes(unpaid) && section.includes('bo@example.com') && section.includes(attemptId));
  assert.ok(!digest.html.includes('cy@example.com') && !digest.html.includes(neverPaid));
  assert.ok(!section.includes('ann@example.com'), 'a paid order is not listed as unpaid');
});

test('an order placed on one day and paid the next is in the paid day\'s summary only', async () => {
  const up = fakeUpstreams(); const env = envForOrders();
  // Placed at 23:55 Jamaica time on the 3rd, paid ten minutes later on the 4th, inside the hold.
  const placed = await call('POST', '/api/orders', { body: body(), env, clock: () => Date.parse('2026-10-04T04:55:00Z') });
  await payOrder(env, placed.json.id, { clock: () => Date.parse('2026-10-04T05:05:00Z') });
  await cron(env, '2026-10-04T13:00:00Z');
  await cron(env, '2026-10-05T13:00:00Z');
  const [day3, day4] = ['2026-10-03', '2026-10-04'].map(d => ownerMails(up).find(e => e.subject.includes(d)));
  assert.match(day3.subject, /\(0 orders\)/);
  assert.match(day4.subject, /\(1 orders\)/);
});

test('saved summaries are sealed, resend unchanged after a failure, and a legacy plaintext part still sends', async () => {
  let fail = true;
  const up = fakeUpstreams({ resend: { fail: b => fail && b.to[0] === 'owner@evincus.shop' } });
  const env = envForOrders(); await placePaid(env);
  await cron(env, '2026-10-04T13:00:00Z');
  const job = await env.ORDERS.get('digest-pending:2026-10-03', 'json');
  assert.equal(job.parts[0].sent, false);
  assert.ok(!env.ORDERS.store.get('digest-pending:2026-10-03').value.includes('ann@example.com'));
  assert.equal(job.parts[0].html, undefined);
  await env.ORDERS.put('digest-pending:2026-09-30', JSON.stringify({ day: '2026-09-30', parts: [{ sent: false, subject: 'old', html: '<p>legacy</p>' }] }));
  fail = false;
  await cron(env, '2026-10-04T13:15:00Z');
  const sent = ownerMails(up);
  const mine = sent.find(e => e.idempotencyKey === 'daily-orders-2026-10-03-0');
  assert.equal(mine.html, await html(env, job.parts[0]));
  assert.ok(sent.some(e => e.html === '<p>legacy</p>'));
  assert.equal(await env.ORDERS.get('digest-pending:2026-10-03'), null);
});

test('orders around midnight use the Jamaica day and the payment capture route is gone', async () => {
  fakeUpstreams(); const env = envForOrders();
  const r = await call('POST', '/api/orders', { body: body(), env, clock: () => Date.parse('2026-10-04T04:59:00Z') });
  assert.ok(env.ORDERS.store.has(`day:2026-10-03:${r.json.id}`));
  assert.equal((await call('POST', '/api/orders/capture', { body: {}, env })).status, 404);
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
  assert.match(up.emails[0].html, /No paid orders/);
  const env = envForOrders();
  const id0 = await placePaid(env);
  const record = await env.ORDERS.get(`order:${id0}`, 'json');
  for (let i = 0; i < 21; i++) {
    const id = `extra-${i}`;
    await env.ORDERS.put(`order:${id}`, JSON.stringify({ ...record, id }));
    await env.ORDERS.put(`paid:2026-10-03:${id}`, '');
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

test('two checkouts racing for the last unit: one order, one bag-changed, stock committed once', async () => {
  fakeUpstreams();
  const env = makeEnv(); await putStock(env, 'alpha-tee|Black, white print|S', 1, 0);
  const [a, b] = await Promise.all([place(oneUnit(), env), place(oneUnit(), env)]);
  assert.deepEqual([a.status, b.status].sort(), [201, 409]);
  assert.equal(stockOf(env, 'alpha-tee|Black, white print|S').committed, 1);
  const loser = [a, b].find(r => r.status === 409).json.error;
  assert.equal(loser.code, 'bag-changed');
  assert.deepEqual([loser.lines[0].status, loser.lines[0].available], ['sold-out', 0]);
  assert.equal([...env.ORDERS.store.keys()].filter(k => k.startsWith('order:')).length, 1);
});

test('a checkout losing the race with units left gets insufficient-stock and how many remain', async () => {
  fakeUpstreams();
  const env = makeEnv(); await putStock(env, SHIRT, 3, 0);
  const [a, b] = await Promise.all([place(body(), env), place(body(), env)]);
  assert.deepEqual([a.status, b.status].sort(), [201, 409]);
  const line = [a, b].find(r => r.status === 409).json.error.lines[0];
  assert.deepEqual([line.status, line.available], ['insufficient-stock', 1]);
  assert.equal(stockOf(env, SHIRT).committed, 2);
});

test('a retried checkout returns the same order and commits stock once', async () => {
  fakeUpstreams();
  const env = makeEnv(); const b = body();
  const responses = [...await Promise.all([place(b, env), place(b, env)]), await place(b, env)];
  assert.ok(responses.every(r => r.status === 201 && r.json.id === responses[0].json.id));
  assert.equal(stockOf(env, SHIRT).committed, 2);
  assert.deepEqual([...env.ORDERS.store.keys()].filter(k => k.startsWith('adj:')), [`adj:alpha-tee:${new Date(NOW).toISOString()}:${responses[0].json.id}:000`]);
});

test('continueSelling oversells instead of refusing', async () => {
  fakeUpstreams();
  const env = makeEnv(); await putStock(env, SHIRT, 0, 0);
  const r = await place(oneUnit(), env, withTee({ continueSelling: true }));
  assert.equal(r.status, 201);
  assert.deepEqual(stockOf(env, SHIRT), { onHand: 0, committed: 1 });
});

test('a cart line for a renamed or removed colour is unknown-item and blocks checkout', async () => {
  fakeUpstreams();
  const env = makeEnv(); // stock still holds 'Black, white print' after the rename
  const data = withTee({ colors: [{ name: 'Jet black', hex: '#151515' }] });
  const q = await call('POST', '/api/bag/quote', { body: { items: oneUnit().items }, env, data });
  assert.equal(q.status, 200);
  assert.equal(q.json.lines[0].status, 'unknown-item');
  const r = await place(oneUnit(), env, data);
  assert.equal(r.status, 409);
  assert.equal(r.json.error.lines[0].status, 'unknown-item');
  assert.equal(stockOf(env, SHIRT).committed, 0);
});

test('orders store sku, costCents and stockCommitted', async () => {
  fakeUpstreams();
  const env = makeEnv();
  const b = { ...body(), items: [{ ...body().items[0], price: 1, sku: 'FORGED', costCents: 1 }] };
  const r = await place(b, env, withTee({ skus: { 'Black, white print|S': 'ALPHA-TEE-PRN-S' }, costCents: 1200 }));
  assert.equal(r.status, 201);
  const record = await env.ORDERS.get(`order:${r.json.id}`, 'json');
  assert.equal(record.stockCommitted, true);
  assert.equal(record.lines[0].sku, 'ALPHA-TEE-PRN-S');
  assert.equal(record.lines[0].costCents, 1200);
});

test('a cart over 8 products gets 400 too-many-products, not bag-changed; 8 products still check out', async () => {
  fakeUpstreams();
  const env = makeEnv();
  // Nine buyable copies of alpha-tee, each in stock, so only the product limit can refuse the cart.
  const data = { ...FIXTURE, products: [...FIXTURE.products, ...Array.from({ length: 9 }, (_, i) => ({ ...FIXTURE.products[0], id: `tee-${i}` }))] };
  for (let i = 0; i < 9; i++) await putStock(env, `tee-${i}|Black, white print|S`, 10);
  const cart = n => ({ ...body(), items: Array.from({ length: n }, (_, i) => ({ id: `tee-${i}`, color: 'Black, white print', size: 'S', qty: 1 })), expectedTotalCents: charges(n * 3499).totalCents });
  const r = await place(cart(9), env, data);
  assert.equal(r.status, 400);
  assert.equal(r.json.error.code, 'too-many-products');
  assert.equal((await place(cart(8), env, data)).status, 201);
});

test('five shoppers checking out one product at once all get their order', async () => {
  fakeUpstreams();
  const env = makeEnv(); // 10 on hand; five orders of 2
  // Commits take a round trip, so reads overlap and each round all but one checkout loses the race.
  const commit = env.ORDERS.commit.bind(env.ORDERS);
  env.ORDERS.commit = async op => { await new Promise(r => setTimeout(r, 10)); return commit(op); };
  const responses = await Promise.all(Array.from({ length: 5 }, () => place(body(), env)));
  assert.deepEqual(responses.map(r => r.status), [201, 201, 201, 201, 201]);
  assert.deepEqual(stockOf(env, SHIRT), { onHand: 10, committed: 10 });
});

test('a checkout that keeps losing the race gets 503 busy, never an unhandled error or owner alert', async () => {
  const up = fakeUpstreams();
  const env = makeEnv();
  env.ORDERS.commit = async () => false;
  const logs = captureLogs();
  let r;
  try { r = await place(body(), env); } finally { logs.restore(); }
  assert.equal(r.status, 503);
  assert.equal(r.json.error.code, 'busy');
  assert.equal(r.json.error.message, 'Lots of people are checking out right now. Your cart is safe — try again in a moment.');
  assert.ok(!logs.lines.some(l => l.event === 'unhandled'));
  assert.equal(up.emails.length, 0);
});
