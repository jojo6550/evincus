import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { call, makeEnv, fakeUpstreams, stockOf, captureLogs } from './helpers/fake-env.mjs';
import { FIXTURE, NOW } from './helpers/fixture.mjs';
import { applyStock } from '../data/catalog.js';
import { fixtureStock } from './helpers/fixture.mjs';
import { formatTotal } from '../server/lib/wipay.js';
import { ORDER_TTL } from '../server/lib/orders.js';

const SHIRT = 'alpha-tee|Black, white print|S';
const WIPAY = { WIPAY_ACCOUNT_NUMBER: '1234567890', WIPAY_API_KEY: '123', WIPAY_ENVIRONMENT: 'sandbox', API_URL: 'https://api.test' };
const body = () => ({ checkoutToken: crypto.randomUUID(), items: [{ id: 'alpha-tee', color: 'Black, white print', size: 'S', qty: 2 }], customer: { firstName: 'Ann', lastName: 'Lee', email: 'ann@example.com', phone: '+1 555 123 4567' }, fulfillment: { type: 'pickup', locationId: 'trendy-hats' }, notes: 'call first', expectedTotalCents: 8437 });
const withTee = over => applyStock({ ...FIXTURE, products: FIXTURE.products.map(p => (p.id === 'alpha-tee' ? { ...p, ...over } : p)) }, fixtureStock());
const at = ms => () => ms;

const keysOf = (env, prefix) => [...env.ORDERS.store.keys()].filter(k => k.startsWith(prefix));
const order = (env, id) => JSON.parse(env.ORDERS.store.get(`order:${id}`).value);
const attempt = (env, aid) => JSON.parse(env.ORDERS.store.get(`payment-attempt:${aid}`).value);
const md5 = s => createHash('md5').update(s).digest('hex');

async function setup({ env: over = {}, data } = {}) {
  const up = fakeUpstreams({ wipay: {} });
  const env = makeEnv({ ...WIPAY, ...over });
  const placed = await call('POST', '/api/orders', { body: body(), env, ...(data && { data }) });
  assert.equal(placed.status, 201, placed.text);
  return { up, env, id: placed.json.id };
}
const pay = (env, id, { clock = at(NOW), data } = {}) => call('POST', `/api/orders/${id}/pay`, { body: {}, env, clock, ...(data && { data }) });
const txnFor = aid => `SB-12-1-${aid}-20261024120000`;
// The redirect WiPay sends after a payment. `total` is WiPay's customer-facing figure; the hash covers ours.
const returnUrl = (env, aid, { status = 'success', txn = txnFor(aid), hash } = {}) => {
  const a = attempt(env, aid);
  const h = hash ?? md5(txn + formatTotal(a.totalCents) + '123');
  return `/api/payments/wipay/return?status=${status}&transaction_id=${txn}&order_id=${aid}&total=${formatTotal(a.totalCents)}&currency=USD&date=2026-10-03&${status === 'success' ? `hash=${h}` : 'message=Declined'}`;
};
const back = (env, path, { clock = at(NOW), data } = {}) => call('GET', path, { env, clock, ...(data && { data }) });
const location = r => r.res.headers.get('location');
const lastAttemptId = up => up.wipay.at(-1).body.order_id;

test('pay without WiPay settings is 503 payments-unavailable and calls nobody', async () => {
  const { up, env, id } = await setup({ env: { WIPAY_API_KEY: undefined } });
  const r = await pay(env, id);
  assert.equal(r.status, 503);
  assert.equal(r.json.error.code, 'payments-unavailable');
  assert.equal(up.wipay.length, 0);
});

test('pay twice within 150 s gives one WiPay session and one attempt; the hold is not extended', async () => {
  const { up, env, id } = await setup();
  const holdBefore = keysOf(env, 'hold:');
  const a = await pay(env, id), b = await pay(env, id, { clock: at(NOW + 149000) });
  assert.equal(a.status, 200);
  assert.equal(a.json.url, 'https://jmsb.wipayfinancial.com/checkout/payment?x=1');
  assert.equal(b.json.url, a.json.url);
  assert.equal(up.wipay.length, 1);
  assert.equal(keysOf(env, 'payment-attempt:').length, 1);
  const aid = lastAttemptId(up);
  const o = order(env, id);
  assert.equal(o.attemptId, aid);
  assert.equal(o.holdUntil, new Date(NOW + 900000).toISOString());
  assert.deepEqual(keysOf(env, 'hold:'), holdBefore);
  assert.equal(env.ORDERS.store.get(`submission:${id}`).opts.expirationTtl, ORDER_TTL);
  assert.equal(env.ORDERS.store.get(`order:${id}`).opts.expirationTtl, undefined);
  assert.equal(env.ORDERS.store.get(`day:2026-10-03:${id}`).opts.expirationTtl, undefined);
  assert.deepEqual(keysOf(env, 'awaiting:'), [`awaiting:2026-10-03:${id}`]);
  assert.deepEqual(attempt(env, aid), { orderId: id, totalCents: 8437, currency: 'USD', url: a.json.url, wipayTransactionId: txnFor(aid), createdAt: new Date(NOW).toISOString(), state: 'open' });
  const sent = up.wipay[0].body;
  assert.equal(sent.total, '84.37');
  assert.equal(sent.response_url, 'https://api.test/api/payments/wipay/return');
  assert.equal(sent.email, 'ann@example.com');
});

test('pay after 151 s with the attempt still open makes a new attempt', async () => {
  const { up, env, id } = await setup();
  await pay(env, id);
  await pay(env, id, { clock: at(NOW + 151000) });
  assert.equal(up.wipay.length, 2);
  assert.equal(keysOf(env, 'payment-attempt:').length, 2);
  assert.equal(order(env, id).attemptId, lastAttemptId(up));
});

test('two concurrent pays return the same url and the order points at one attempt', async () => {
  const { up, env, id } = await setup();
  let n = 0;
  up.wipay.length = 0;
  fakeUpstreams({ wipay: { reply: b => ({ body: { url: `https://jmsb.wipayfinancial.com/checkout/payment?x=${++n}`, message: 'OK', transaction_id: txnFor(b.order_id) } }) } });
  const [a, b] = await Promise.all([pay(env, id), pay(env, id)]);
  assert.equal(a.json.url, b.json.url);
  const aid = order(env, id).attemptId;
  assert.equal(attempt(env, aid).url, a.json.url);
});

test('pay with WiPay refusing is 502 payment-unavailable, saves nothing', async () => {
  const { env, id } = await setup();
  const before = env.ORDERS.store.get(`order:${id}`).value;
  fakeUpstreams({ wipay: { reply: () => ({ status: 400, body: { message: 'bad' } }) } });
  const r = await pay(env, id);
  assert.equal(r.status, 502);
  assert.equal(r.json.error.code, 'payment-unavailable');
  assert.equal(keysOf(env, 'payment-attempt:').length, 0);
  assert.equal(env.ORDERS.store.get(`order:${id}`).value, before);
});

test('a sale between place and pay changes nothing: WiPay gets the stored total', async () => {
  const { up, env, id } = await setup();
  await pay(env, id, { data: withTee({ priceCents: 999 }) });
  assert.equal(up.wipay[0].body.total, formatTotal(order(env, id).totalCents));
  assert.equal(up.wipay[0].body.total, '84.37');
});

test('pay on an unknown order is 404; on a paid order no WiPay call', async () => {
  const { up, env, id } = await setup();
  assert.equal((await pay(env, 'EV-00000000-0000-4000-8000-000000000000')).status, 404);
  await pay(env, id);
  await back(env, returnUrl(env, lastAttemptId(up)));
  const r = await pay(env, id, { clock: at(NOW + 200000) });
  assert.deepEqual(r.json, { paid: true });
  assert.equal(up.wipay.length, 1);
});

test('a successful return marks the order paid once, releases the hold key, keeps stock, sends one receipt', async () => {
  const { up, env, id } = await setup({ data: withTee({ costCents: 1200 }) });
  await pay(env, id);
  const aid = lastAttemptId(up);
  const r = await back(env, returnUrl(env, aid), { data: withTee({ costCents: 1500 }) });
  assert.equal(r.status, 303);
  assert.equal(location(r), `/order.html?order=${id}&checkout=paid`);
  const o = order(env, id);
  assert.deepEqual([o.status, o.paymentStatus], ['PLACED', 'PAID']);
  assert.deepEqual(o.payment, { provider: 'wipay', transactionId: txnFor(aid), paidAt: new Date(NOW).toISOString(), chargedTotal: '84.37', currency: 'USD' });
  assert.equal(o.holdUntil, undefined);
  assert.equal(o.stockCommitted, true);
  assert.equal(o.events.at(-1).type, 'paid');
  assert.equal(o.lines[0].costCents, 1500);
  assert.equal(stockOf(env, SHIRT).committed, 2);
  assert.deepEqual(keysOf(env, 'hold:'), []);
  assert.deepEqual(keysOf(env, 'wipay-txn:'), [`wipay-txn:${txnFor(aid)}`]);
  assert.deepEqual(JSON.parse(env.ORDERS.store.get(`wipay-txn:${txnFor(aid)}`).value), { orderId: id, attemptId: aid, duplicate: false });
  assert.deepEqual(keysOf(env, 'day:'), [`day:2026-10-03:${id}`]);
  const meta = env.ORDERS.store.get(`day:2026-10-03:${id}`).opts.metadata;
  assert.equal(meta.payment, 'PAID');
  assert.equal(meta.paidAt, new Date(NOW).toISOString());
  assert.deepEqual(keysOf(env, 'paid:'), [`paid:2026-10-03:${id}`]);
  assert.deepEqual(env.ORDERS.store.get(`paid:2026-10-03:${id}`).opts.metadata, { totalCents: 8437, taxCents: 1050, feeCents: 389, paidAt: new Date(NOW).toISOString() });
  assert.equal(attempt(env, aid).state, 'paid');
  const receipts = up.emails.filter(e => e.to[0] === 'ann@example.com');
  assert.equal(receipts.length, 1);
  assert.deepEqual(keysOf(env, 'email-retry:'), [], 'sent, so its retry job is gone');
});

test('the paid commit carries the receipt retry job, so a failed send is retried', async () => {
  const { up, env, id } = await setup();
  fakeUpstreams({ wipay: {}, resend: { fail: () => true } });
  await pay(env, id);
  const aid = order(env, id).attemptId;
  await back(env, returnUrl(env, aid));
  assert.deepEqual(keysOf(env, 'email-retry:'), [`email-retry:${id}`]);
  assert.equal(up.emails.length, 0);
});

test('paying on a later Jamaica day: day: stays on the placed day, paid: is on the paid day', async () => {
  const { up, env, id } = await setup();
  await pay(env, id);
  await back(env, returnUrl(env, lastAttemptId(up)), { clock: at(NOW + 2 * 86400000) });
  assert.deepEqual(keysOf(env, 'day:'), [`day:2026-10-03:${id}`]);
  assert.deepEqual(keysOf(env, 'paid:'), [`paid:2026-10-05:${id}`]);
});

test('the same return twice, and twice at once: one paid order, one wipay-txn, one receipt', async () => {
  for (const together of [false, true]) {
    const { up, env, id } = await setup();
    await pay(env, id);
    const url = returnUrl(env, lastAttemptId(up));
    const rs = together ? await Promise.all([back(env, url), back(env, url)]) : [await back(env, url), await back(env, url)];
    assert.ok(rs.every(r => r.status === 303 && location(r).endsWith('checkout=paid')));
    assert.equal(keysOf(env, 'wipay-txn:').length, 1);
    assert.equal(keysOf(env, 'paid:').length, 1);
    assert.equal(up.emails.filter(e => e.to[0] === 'ann@example.com').length, 1);
    assert.equal(order(env, id).events.filter(e => e.type === 'paid').length, 1);
  }
});

test('two different successful transactions: paid by the first, the second recorded duplicate with one alert', async () => {
  const { up, env, id } = await setup();
  await pay(env, id);
  const first = lastAttemptId(up);
  await pay(env, id, { clock: at(NOW + 151000) });
  const second = lastAttemptId(up);
  assert.notEqual(first, second);
  const url2 = returnUrl(env, second);
  await back(env, returnUrl(env, first));
  const r = await back(env, url2);
  await back(env, url2);
  assert.equal(location(r), `/order.html?order=${id}&checkout=paid`);
  assert.equal(order(env, id).payment.transactionId, txnFor(first));
  assert.deepEqual(JSON.parse(env.ORDERS.store.get(`wipay-txn:${txnFor(second)}`).value), { orderId: id, attemptId: second, duplicate: true });
  const alerts = up.emails.filter(e => e.to[0] === 'owner@evincus.shop');
  assert.equal(alerts.length, 1);
  assert.ok(alerts[0].html.includes(txnFor(first)) && alerts[0].html.includes(txnFor(second)));
  assert.equal(keysOf(env, 'paid:').length, 1);
});

test('a bad hash, a sandbox ID on live, or another attempt\'s ID is failed, unpaid, alerted, and never logs the hash', async () => {
  const cases = [
    { over: {}, url: (env, aid) => returnUrl(env, aid, { hash: 'f'.repeat(32) }), hash: 'f'.repeat(32) },
    { over: { WIPAY_ENVIRONMENT: 'live' }, url: (env, aid) => returnUrl(env, aid) },
    { over: {}, url: (env, aid) => returnUrl(env, aid, { txn: txnFor('OTHERattempt0001') }) },
  ];
  for (const { over, url, hash } of cases) {
    const { up, env, id } = await setup({ env: over });
    await pay(env, id);
    const path = url(env, lastAttemptId(up));
    const logs = captureLogs();
    let r;
    try { r = await back(env, path); } finally { logs.restore(); }
    assert.equal(location(r), `/order.html?order=${id}&checkout=failed`);
    assert.equal(order(env, id).paymentStatus, 'UNPAID');
    assert.equal(keysOf(env, 'wipay-txn:').length, 0);
    assert.ok(logs.lines.some(l => l.event === 'payment.hash_mismatch'));
    assert.ok(up.emails.some(e => e.to[0] === 'owner@evincus.shop'));
    if (hash) assert.ok(!JSON.stringify(logs.lines).includes(hash));
  }
});

test('a failed return marks the attempt failed; the next pay makes a new attempt', async () => {
  const { up, env, id } = await setup();
  await pay(env, id);
  const aid = lastAttemptId(up);
  const r = await back(env, returnUrl(env, aid, { status: 'failed' }));
  assert.equal(location(r), `/order.html?order=${id}&checkout=failed`);
  assert.equal(attempt(env, aid).state, 'failed');
  assert.equal(order(env, id).paymentStatus, 'UNPAID');
  await pay(env, id, { clock: at(NOW + 10000) });
  assert.equal(up.wipay.length, 2);
  assert.notEqual(order(env, id).attemptId, aid);
});

test('garbage returns are 303 failed, change nothing and never 500', async () => {
  const { up, env, id } = await setup();
  await pay(env, id);
  const aid = lastAttemptId(up);
  const state = () => JSON.stringify([...env.ORDERS.store].filter(([k]) => /^(order|payment-attempt|wipay-txn|paid|day|hold|email-retry|submission):/.test(k)));
  const before = state();
  for (const path of [
    '/api/payments/wipay/return',
    '/api/payments/wipay/return?status=success&order_id=NOPEnopeNOPEnope&transaction_id=x&hash=y',
    `/api/payments/wipay/return?status=success&order_id=${aid}&transaction_id=${txnFor(aid)}`,
    `/api/payments/wipay/return?status=success&status=failed&order_id=${aid}&transaction_id=${txnFor(aid)}&hash=abc`,
    `/api/payments/wipay/return?status=success&order_id=${aid}&transaction_id=${'x'.repeat(5000)}&hash=abc`,
    '/api/payments/wipay/return?order_id=%E0%A4%A',
  ]) {
    const r = await back(env, path);
    assert.equal(r.status, 303, path);
    assert.match(location(r), /checkout=failed$/, path);
  }
  assert.equal(state(), before);
});

test('return and status work in maintenance; pay does not', async () => {
  const { up, env, id } = await setup();
  await pay(env, id);
  env.STATUS = 'maintenance';
  assert.equal((await pay(env, id)).status, 503);
  const r = await back(env, returnUrl(env, lastAttemptId(up)));
  assert.equal(location(r), `/order.html?order=${id}&checkout=paid`);
  const s = await call('GET', `/api/orders/${id}/status`, { env });
  assert.equal(s.status, 200);
  assert.equal(s.json.paymentStatus, 'PAID');
});

test('status shows the seven public fields and nothing personal; unknown is 404', async () => {
  const { up, env, id } = await setup();
  const s0 = await call('GET', `/api/orders/${id}/status`, { env });
  assert.deepEqual(s0.json, { id, status: 'AWAITING_PAYMENT', paymentStatus: 'UNPAID', totalCents: 8437, paidAt: null, transactionId: null, fulfillmentType: 'pickup' });
  await pay(env, id);
  await back(env, returnUrl(env, lastAttemptId(up)));
  const s = await call('GET', `/api/orders/${id}/status`, { env });
  assert.deepEqual(Object.keys(s.json).sort(), ['fulfillmentType', 'id', 'paidAt', 'paymentStatus', 'status', 'totalCents', 'transactionId']);
  assert.equal(s.json.transactionId, txnFor(lastAttemptId(up)));
  assert.ok(!s.text.includes('ann@example.com') && !s.text.includes('Ann'));
  assert.equal((await call('GET', '/api/orders/EV-00000000-0000-4000-8000-000000000000/status', { env })).status, 404);
});

test('a cancelled order cannot start a payment', async () => {
  const { up, env, id } = await setup();
  await env.ORDERS.put(`order:${id}`, JSON.stringify({ ...order(env, id), fulfilmentStatus: 'CANCELLED' }));
  const r = await pay(env, id);
  assert.equal(r.status, 409);
  assert.equal(r.json.error.code, 'order-cancelled');
  assert.equal(up.wipay.length, 0);
});
