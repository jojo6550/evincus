import test from 'node:test';
import assert from 'node:assert/strict';
import { call, makeEnv, fakeUpstreams, captureLogs } from './helpers/fake-env.mjs';
import { FIXTURE, NOW } from './helpers/fixture.mjs';

const item = (over = {}) => ({ id: 'alpha-tee', color: 'Black, white print', size: 'S', qty: 2, ...over });
const create = async (env, items = [item()]) => (await call('POST', '/api/orders', { body: { items }, env })).json.id;
const capture = (env, orderID, opts = {}) => call('POST', '/api/orders/capture', { body: { orderID }, env, ...opts });
const withProduct = (id, patch) => ({ ...FIXTURE, products: FIXTURE.products.map(p => (p.id === id ? { ...p, ...patch } : p)) });

test('happy path: captures, logs the order to KV, returns the confirmation', async () => {
  const up = fakeUpstreams();
  const env = makeEnv();
  const id = await create(env);
  const { status, json } = await capture(env, id);
  assert.equal(status, 200);
  assert.deepEqual(json, { id, status: 'COMPLETED', totalCents: 7498, name: 'Ann', email: 'ann@example.com' });

  const cap = up.captures();
  assert.equal(cap.length, 1);
  assert.equal(cap[0].headers.get('PayPal-Request-Id'), id);

  const saved = env.ORDERS.store.get(`order:${id}`);
  assert.equal(saved.opts.expirationTtl, 63072000);
  const record = JSON.parse(saved.value);
  assert.equal(record.captureId, 'CAPTURE1');
  assert.equal(record.capturedAt, new Date(NOW).toISOString());
  assert.deepEqual(record.lines, [{ key: 'alpha-tee|Black, white print|S', name: 'Alpha <Tee>', color: 'Black, white print', size: 'S', qty: 2, unitCents: 3499 }]);
  assert.deepEqual(record.payer, { name: 'Ann Lee', firstName: 'Ann', email: 'ann@example.com' });
  assert.equal(record.shipTo.address.address_line_1, '1 Main St');
  assert.ok(env.ORDERS.store.has(`day:2026-10-03:${id}`));
});

test('capturing twice returns the stored result without calling PayPal again', async () => {
  const up = fakeUpstreams();
  const env = makeEnv();
  const id = await create(env);
  const first = await capture(env, id);
  const callsAfterFirst = up.calls.length;
  const second = await capture(env, id);
  assert.deepEqual(second.json, first.json);
  assert.equal(up.calls.length, callsAfterFirst);
});

test('if the KV idempotency read fails, capture still proceeds safely', async () => {
  const up = fakeUpstreams();
  const env = makeEnv();
  const id = await create(env);
  env.ORDERS.failGets = key => key.startsWith('order:');
  const { status } = await capture(env, id);
  assert.equal(status, 200);
  assert.equal(up.captures()[0].headers.get('PayPal-Request-Id'), id);
});

test('an order not created by this server is refused, logged as tag-mismatch, and alerted', async () => {
  const up = fakeUpstreams();
  const env = makeEnv();
  up.orders.set('FOREIGN12345', {
    id: 'FOREIGN12345', status: 'APPROVED',
    purchase_units: [{ custom_id: 'abc.def', amount: { currency_code: 'USD', value: '0.01' } }],
  });
  const logs = captureLogs();
  let r;
  try { r = await capture(env, 'FOREIGN12345'); } finally { logs.restore(); }
  assert.equal(r.status, 409);
  assert.equal(r.json.error.code, 'capture-refused');
  assert.equal(up.captures().length, 0);
  assert.ok(logs.lines.some(l => l.event === 'capture.refused' && l.code === 'tag-mismatch' && l.level === 'error'));
  assert.ok(up.emails.some(e => /tampering/i.test(e.subject)));
});

test('an amount changed after signing fails the tag check', async () => {
  const up = fakeUpstreams();
  const env = makeEnv();
  const id = await create(env);
  up.orders.get(id).purchase_units[0].amount.value = '0.01';
  const r = await capture(env, id);
  assert.equal(r.status, 409);
  assert.equal(up.captures().length, 0);
});

test('a replayed tag on cheaper contents is refused as reprice-mismatch', async () => {
  const up = fakeUpstreams();
  const env = makeEnv();
  const id = await create(env);
  const real = up.orders.get(id).purchase_units[0];
  up.orders.set('REPLAY123456', {
    id: 'REPLAY123456', status: 'APPROVED',
    purchase_units: [{ ...real, items: [{ ...real.items[0], quantity: '1' }] }],
  });
  const logs = captureLogs();
  let r;
  try { r = await capture(env, 'REPLAY123456'); } finally { logs.restore(); }
  assert.equal(r.status, 409);
  assert.equal(r.json.error.code, 'capture-refused');
  assert.ok(logs.lines.some(l => l.event === 'capture.refused' && l.code === 'reprice-mismatch'));
  assert.equal(up.captures().length, 0);
});

test('a tampered line price with a legit total is refused', async () => {
  const up = fakeUpstreams();
  const env = makeEnv();
  const id = await create(env);
  up.orders.get(id).purchase_units[0].items[0].unit_amount.value = '0.01';
  assert.equal((await capture(env, id)).status, 409);
  assert.equal(up.captures().length, 0);
});

test('an item that sold out after checkout started is refused with bag-changed, not charged', async () => {
  const up = fakeUpstreams();
  const env = makeEnv();
  const id = await create(env);
  const r = await capture(env, id, { data: withProduct('alpha-tee', { soldOut: true }) });
  assert.equal(r.status, 409);
  assert.equal(r.json.error.code, 'bag-changed');
  assert.equal(r.json.error.lines[0].status, 'sold-out');
  assert.equal(up.captures().length, 0);
});

test('an era that ended after checkout started is refused with bag-changed', async () => {
  const up = fakeUpstreams();
  const env = makeEnv();
  const id = await create(env);
  const ended = { ...FIXTURE, eras: FIXTURE.eras.map(e => (e.slug === 'alpha' ? { ...e, endsAt: '2026-10-03T11:00:00Z' } : e)) };
  const r = await capture(env, id, { data: ended });
  assert.equal(r.json.error.code, 'bag-changed');
  assert.equal(up.captures().length, 0);
});

test('a captured amount that differs is 502, alerted, and not logged as an order', async () => {
  const up = fakeUpstreams({ paypal: { paidValue: '1.00' } });
  const env = makeEnv();
  const id = await create(env);
  const logs = captureLogs();
  let r;
  try { r = await capture(env, id); } finally { logs.restore(); }
  assert.equal(r.status, 502);
  assert.equal(r.json.error.code, 'capture-mismatch');
  assert.ok(logs.lines.some(l => l.event === 'capture.refused' && l.code === 'amount-mismatch'));
  assert.ok(up.emails.some(e => /amount/i.test(e.subject)));
  assert.ok(!env.ORDERS.store.has(`order:${id}`));
});

test('a declined payment is 422 and does not count toward the outage alert', async () => {
  const up = fakeUpstreams({ paypal: { decline: true } });
  const env = makeEnv();
  const id = await create(env);
  const r = await capture(env, id);
  assert.equal(r.status, 422);
  assert.equal(r.json.error.code, 'payment-declined');
  assert.ok(![...env.ORDERS.store.keys()].some(k => k.startsWith('paypal-errors:')));
  assert.equal(up.emails.length, 0);
});

test('an order that is not APPROVED is refused', async () => {
  const up = fakeUpstreams();
  const env = makeEnv();
  const id = await create(env);
  up.orders.get(id).status = 'CREATED';
  const r = await capture(env, id);
  assert.equal(r.status, 409);
  assert.equal(r.json.error.code, 'capture-refused');
  assert.equal(up.captures().length, 0);
});

test('malformed order ids are 400 and GET is 405', async () => {
  fakeUpstreams();
  assert.equal((await capture(makeEnv(), '../x')).status, 400);
  assert.equal((await call('GET', '/api/orders/capture')).status, 405);
});

test('if writing the order to KV fails, the shopper still gets 200 and the owner gets the full record', async () => {
  const up = fakeUpstreams();
  const env = makeEnv();
  const id = await create(env);
  env.ORDERS.failPuts = key => key.startsWith('order:') || key.startsWith('day:');
  const logs = captureLogs();
  let r;
  try { r = await capture(env, id); } finally { logs.restore(); }
  assert.equal(r.status, 200);
  const failed = logs.lines.find(l => l.event === 'order.log_failed');
  assert.equal(failed.orderId, id);
  assert.ok(!JSON.stringify(logs.lines).includes('ann@example.com'));
  const mail = up.emails.find(e => /not saved/i.test(e.subject));
  assert.ok(mail.html.includes('ann@example.com'));
  assert.ok(mail.html.includes(id));
});

test('a paid order whose KV save failed is recorded on retry without a second PayPal capture', async () => {
  const up = fakeUpstreams();
  const env = makeEnv();
  const id = await create(env);
  env.ORDERS.failPuts = key => key.startsWith('order:') || key.startsWith('day:');
  const first = await capture(env, id);
  assert.equal(first.status, 200);
  env.ORDERS.failPuts = null;
  const second = await capture(env, id);
  assert.equal(second.status, 200);
  assert.deepEqual(second.json, first.json);
  assert.equal(JSON.parse(env.ORDERS.store.get(`order:${id}`).value).captureId, 'CAPTURE1');
  assert.equal(up.captures().length, 1);
});

test('a network error after PayPal charged is recovered by re-reading the order', async () => {
  const up = fakeUpstreams({ paypal: { networkAfterCapture: true } });
  const env = makeEnv();
  const id = await create(env);
  const r = await capture(env, id);
  assert.equal(r.status, 200);
  assert.equal(r.json.totalCents, 7498);
  assert.ok(env.ORDERS.store.has(`order:${id}`));
  assert.equal(up.captures().length, 1);
});

test('an already-captured order with a bad tag is refused and not recorded', async () => {
  const up = fakeUpstreams();
  const env = makeEnv();
  up.orders.set('FOREIGN12345', {
    id: 'FOREIGN12345', status: 'COMPLETED',
    purchase_units: [{ custom_id: 'abc.def', amount: { currency_code: 'USD', value: '0.01' } }],
  });
  const r = await capture(env, 'FOREIGN12345');
  assert.equal(r.status, 409);
  assert.equal(r.json.error.code, 'capture-refused');
  assert.ok(!env.ORDERS.store.has('order:FOREIGN12345'));
});

test('a capture that errors with 500 but charged anyway is recorded from the re-read order', async () => {
  const up = fakeUpstreams({ paypal: { captureErrors: [500], chargeOnError: true } });
  const env = makeEnv();
  const id = await create(env);
  const r = await capture(env, id);
  assert.equal(r.status, 200);
  assert.equal(r.json.totalCents, 7498);
  assert.ok(env.ORDERS.store.has(`order:${id}`));
  assert.equal(up.captures().length, 1);
});

test('a capture that errors with 500 twice while the order stays APPROVED is 502 capture-unknown, not "not charged"', async () => {
  const up = fakeUpstreams({ paypal: { captureErrors: [500, 500] } });
  const env = makeEnv();
  const id = await create(env);
  const r = await capture(env, id);
  assert.equal(r.status, 502);
  assert.equal(r.json.error.code, 'capture-unknown');
  assert.match(r.json.error.message, /Don't pay again/);
  assert.doesNotMatch(r.json.error.message, /not charged/);
  assert.equal(up.captures().length, 2);
  assert.ok(!env.ORDERS.store.has(`order:${id}`));
});

test('capture-path paypal.error log lines carry the order id', async () => {
  fakeUpstreams({ paypal: { captureErrors: [500, 500] } });
  const env = makeEnv();
  const id = await create(env);
  const logs = captureLogs();
  try { await capture(env, id); } finally { logs.restore(); }
  const errors = logs.lines.filter(l => l.event === 'paypal.error');
  assert.ok(errors.length >= 1);
  assert.ok(errors.every(l => l.orderId === id && l.op === 'capture' && l.upstreamStatus === 500));
});

test('a 500 then a successful retry captures once at PayPal and records the order', async () => {
  const up = fakeUpstreams({ paypal: { captureErrors: [500] } });
  const env = makeEnv();
  const id = await create(env);
  const r = await capture(env, id);
  assert.equal(r.status, 200);
  assert.equal(up.captures().length, 2);
  assert.ok(up.captures().every(c => c.headers.get('PayPal-Request-Id') === id));
  assert.ok(env.ORDERS.store.has(`order:${id}`));
});

test('a 500 then a definite 400 on retry with the order still APPROVED says not charged', async () => {
  fakeUpstreams({ paypal: { captureErrors: [500, 400] } });
  const env = makeEnv();
  const id = await create(env);
  const r = await capture(env, id);
  assert.equal(r.status, 502);
  assert.equal(r.json.error.code, 'paypal-error');
});

test('a 500 then a 422 on retry is still a decline', async () => {
  fakeUpstreams({ paypal: { captureErrors: [500, 422] } });
  const env = makeEnv();
  const id = await create(env);
  const r = await capture(env, id);
  assert.equal(r.status, 422);
  assert.equal(r.json.error.code, 'payment-declined');
});

test('a pending capture is recorded, flagged, and the owner is told not to ship', async () => {
  const up = fakeUpstreams({ paypal: { captureStatus: 'PENDING' } });
  const env = makeEnv();
  const id = await create(env);
  const logs = captureLogs();
  let r;
  try { r = await capture(env, id); } finally { logs.restore(); }
  assert.equal(r.status, 200);
  const record = JSON.parse(env.ORDERS.store.get(`order:${id}`).value);
  assert.equal(record.captureStatus, 'PENDING');
  assert.ok(logs.lines.some(l => l.event === 'order.payment_pending' && l.level === 'warn' && l.orderId === id && l.captureStatus === 'PENDING'));
  assert.ok(up.emails.some(e => /Payment pending on order/.test(e.subject)));
  const owner = up.emails.find(e => e.subject.startsWith('New order'));
  assert.ok(owner.html.includes('don&#39;t ship'));
});

test('a completed capture records captureStatus COMPLETED and no pending row', async () => {
  const up = fakeUpstreams();
  const env = makeEnv();
  const id = await create(env);
  await capture(env, id);
  assert.equal(JSON.parse(env.ORDERS.store.get(`order:${id}`).value).captureStatus, 'COMPLETED');
  assert.ok(!up.emails.some(e => /pending/i.test(e.subject) || e.html.includes('don&#39;t ship')));
});

test('recovering an order PayPal already captured records the charged amounts, not current catalog prices', async () => {
  const up = fakeUpstreams();
  const env = makeEnv();
  const id = await create(env);
  const o = up.orders.get(id);
  o.status = 'COMPLETED';
  o.payer = { name: { given_name: 'Ann', surname: 'Lee' }, email_address: 'ann@example.com' };
  o.purchase_units[0].payments = { captures: [{ id: 'CAPTURE1', status: 'COMPLETED', amount: o.purchase_units[0].amount }] };
  const r = await capture(env, id, { data: withProduct('alpha-tee', { priceCents: 9999 }) });
  assert.equal(r.status, 200);
  assert.equal(r.json.totalCents, 7498);
  const record = JSON.parse(env.ORDERS.store.get(`order:${id}`).value);
  assert.equal(record.subtotalCents, 6998);
  assert.equal(record.shippingCents, 500);
  assert.equal(record.totalCents, 7498);
  assert.deepEqual(record.lines, [{ key: 'alpha-tee|Black, white print|S', name: 'Alpha <Tee>', color: 'Black, white print', size: 'S', qty: 2, unitCents: 3499 }]);
  assert.equal(up.captures().length, 0);
});

test('a definite refusal on the first capture of an order PayPal shows captured is recorded, not called a decline', async () => {
  const up = fakeUpstreams({ paypal: { captureErrors: [422], chargeOnError: true } });
  const env = makeEnv();
  const id = await create(env);
  const r = await capture(env, id);
  assert.equal(r.status, 200);
  assert.equal(r.json.status, 'COMPLETED');
  assert.equal(up.captures().length, 1);
  assert.ok(env.ORDERS.store.has(`order:${id}`));
});

test('concurrent captures of one order charge once and send each email under one idempotency key', async () => {
  const up = fakeUpstreams();
  const env = makeEnv();
  const id = await create(env);
  const [a, b] = await Promise.all([capture(env, id), capture(env, id)]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.deepEqual(a.json, b.json);
  assert.ok(up.captures().every(c => c.headers.get('PayPal-Request-Id') === id));
  const keys = new Set(up.emails.map(e => e.idempotencyKey));
  assert.deepEqual([...keys].sort(), [`${id}-customer`, `${id}-owner`]);
  const bodies = key => new Set(up.emails.filter(e => e.idempotencyKey === key).map(e => e.html));
  assert.equal(bodies(`${id}-owner`).size, 1);
  assert.equal(bodies(`${id}-customer`).size, 1);
});

test('the record uses PayPal\'s capture time, so repeated finishes build the same record', async () => {
  fakeUpstreams({ paypal: { createTime: '2026-10-02T23:59:30Z' } });
  const env = makeEnv();
  const id = await create(env);
  await capture(env, id);
  const record = JSON.parse(env.ORDERS.store.get(`order:${id}`).value);
  assert.equal(record.capturedAt, '2026-10-02T23:59:30.000Z');
  assert.ok(env.ORDERS.store.has(`day:2026-10-02:${id}`));
});
