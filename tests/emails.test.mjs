import test from 'node:test';
import assert from 'node:assert/strict';
import { call, makeEnv, makeCtx, fakeUpstreams, captureLogs } from './helpers/fake-env.mjs';
import { FIXTURE, NOW } from './helpers/fixture.mjs';
import { createApp } from '../server/index.js';
import { sendOrderEmails } from '../server/lib/delivery.js';
import { createLogger } from '../server/lib/log.js';

const MIN = 60_000;
const item = { id: 'alpha-tee', color: 'Black, white print', size: 'S', qty: 2 };

const order = () => ({ checkoutToken: crypto.randomUUID(), items: [item], customer: { firstName: 'Ann', lastName: 'Lee', email: 'ann@example.com', phone: '+1 555 123 4567' }, fulfillment: { type: 'pickup', locationId: 'trendy-hats' }, expectedTotalCents: 8437 });
// Places an order, then sends its receipt as a confirmed payment does.
const buy = async env => {
  const id = (await call('POST', '/api/orders', { body: order(), env })).json.id;
  await sendOrderEmails({ env, now: new Date(NOW), log: createLogger() }, JSON.parse(env.ORDERS.store.get(`order:${id}`).value));
  return id;
};

async function cron(env, at) {
  const app = createApp({ data: FIXTURE, clock: () => at });
  const ctx = makeCtx();
  await app.scheduled({ cron: '*/15 * * * *', scheduledTime: at }, env, ctx);
  await ctx.settle();
}

const record = (env, id) => JSON.parse(env.ORDERS.store.get(`order:${id}`).value);
const retryState = (env, id) => {
  const v = env.ORDERS.store.get(`email-retry:${id}`);
  return v && JSON.parse(v.value);
};

test('the receipt goes to the customer and the owner waits for the daily summary', async () => {
  const up = fakeUpstreams();
  const env = makeEnv();
  const id = await buy(env);
  assert.equal(up.emails.length, 1);
  const customer = up.emails[0];
  assert.equal(customer.to[0], 'ann@example.com');
  assert.equal(customer.subject, `Your Evincus order ${id}`);
  assert.equal(customer.idempotencyKey, `${id}-customer`);
  assert.ok(customer.html.includes('Alpha &lt;Tee&gt;'));
  assert.ok(!customer.html.includes('<Tee>'));
  assert.ok(customer.html.includes('$69.98'));
  assert.deepEqual(record(env, id).email, { customer: 'sent', owner: 'daily-summary', attempts: 1 });
  assert.equal(retryState(env, id), undefined);
});

test('a failed receipt is queued for retry 15 minutes later', async () => {
  const up = fakeUpstreams({ resend: { fail: b => b.to[0] === 'ann@example.com' } });
  const env = makeEnv();
  const id = await buy(env);
  assert.deepEqual(record(env, id).email, { customer: 'failed', owner: 'daily-summary', attempts: 1 });
  assert.deepEqual(retryState(env, id), { retries: 0, nextAt: NOW + 15 * MIN });
  assert.equal(up.emails.length, 0);
});

test('cron waits until the retry is due, then resends only what failed', async () => {
  let failing = true;
  const up = fakeUpstreams({ resend: { fail: b => failing && b.to[0] === 'ann@example.com' } });
  const env = makeEnv();
  const id = await buy(env);
  await cron(env, NOW + 14 * MIN);
  assert.equal(up.emails.length, 0);
  failing = false;
  await cron(env, NOW + 15 * MIN);
  assert.deepEqual(up.emails.map(e => e.to[0]), ['ann@example.com']);
  assert.deepEqual(record(env, id).email, { customer: 'sent', owner: 'daily-summary', attempts: 2 });
  assert.equal(retryState(env, id), undefined);
});

test('retries back off 30, 60, 120, 240 minutes, then give up with an alert', async () => {
  const up = fakeUpstreams({ resend: { fail: b => b.to[0] === 'ann@example.com' } });
  const env = makeEnv();
  const id = await buy(env);
  let at = NOW + 15 * MIN;
  for (const wait of [30, 60, 120, 240]) {
    await cron(env, at);
    const s = retryState(env, id);
    assert.equal(s.nextAt, at + wait * MIN);
    at = s.nextAt;
  }
  const logs = captureLogs();
  try { await cron(env, at); } finally { logs.restore(); }
  assert.equal(retryState(env, id), undefined);
  assert.ok(logs.lines.some(l => l.event === 'email.gave_up' && l.orderId === id));
  assert.ok(up.emails.some(e => e.to[0] === 'owner@evincus.shop' && /Receipt not delivered/.test(e.subject)));
  assert.equal(record(env, id).email.attempts, 6);
});

test('cron drops retry keys whose order record is gone', async () => {
  fakeUpstreams();
  const env = makeEnv();
  await env.ORDERS.put('email-retry:GHOST1234', JSON.stringify({ retries: 0, nextAt: NOW }));
  await cron(env, NOW);
  assert.equal(env.ORDERS.store.has('email-retry:GHOST1234'), false);
});

test('a full purchase with emails writes no PII to logs', async () => {
  fakeUpstreams({ resend: { fail: b => b.to[0] === 'ann@example.com' } });
  const env = makeEnv();
  const logs = captureLogs();
  try {
    await buy(env);
    await cron(env, NOW + 15 * MIN);
  } finally { logs.restore(); }
  const all = JSON.stringify(logs.lines);
  for (const pii of ['ann@example.com', 'Ann Lee', '+1 555 123 4567']) assert.ok(!all.includes(pii), pii);
});

test('a failed record update after sending still queues the email retry', async () => {
  fakeUpstreams({ resend: { fail: b => b.to[0] === 'ann@example.com' } });
  const env = makeEnv();
  let orderPuts = 0;
  env.ORDERS.failPuts = key => key.startsWith('order:') && ++orderPuts > 1; // the placement commit succeeds, the update fails
  const logs = captureLogs();
  let id;
  try { id = await buy(env); } finally { logs.restore(); }
  assert.equal(orderPuts, 2);
  assert.deepEqual(retryState(env, id), { retries: 0, nextAt: NOW + 15 * MIN });
});

const paidPickup = () => ({
  id: 'EV-1', status: 'PLACED', paymentStatus: 'PAID', placedAt: '2026-10-24T11:50:00.000Z',
  lines: [{ key: 'a|Black|S', id: 'a', name: 'Alpha <Tee>', color: 'Black', size: 'S', qty: 2, unitCents: 3499 }],
  subtotalCents: 6998, taxCents: 1050, feeCents: 389, taxBps: 1500, feeBps: 483, totalCents: 8437,
  fulfillment: { type: 'pickup', location: { id: 'trendy-hats', name: 'TrendyHatz', area: 'Bankhouse Mall, Mandeville', address: null } },
  payment: { provider: 'wipay', transactionId: 'SB-12-1-Ab3dE5gH7jK9mN1p-20261024120000', paidAt: '2026-10-24T12:00:00.000Z', chargedTotal: '84.37', currency: 'USD' },
  customer: { firstName: 'Ann', lastName: 'Lee', name: 'Ann Lee', email: 'ann@example.com', phone: '+1 555 123 4567' }, address: null, notes: '',
});

test('a paid receipt shows Jamaica paid time, transaction, the four money rows, pickup and the refund window', async () => {
  const { receiptEmail } = await import('../server/emails/receipt.js');
  const { html } = receiptEmail(paidPickup(), 'https://evincus.shop');
  for (const s of ['Oct 24, 2026, 7:00 AM', 'SB-12-1-Ab3dE5gH7jK9mN1p-20261024120000', 'Subtotal', '$69.98', 'GCT (15%)', '$10.50',
    'Processing fee (4.83%, non-refundable)', '$3.89', '$84.37 USD', 'TrendyHatz', 'https://evincus.shop/policies.html#refund', 'within 24 hours']) assert.ok(html.includes(s), s);
  assert.ok(!html.includes('No payment was collected'));
  assert.ok(html.includes('Alpha &lt;Tee&gt;'));
});

test('a shipping receipt shows the address and the shipping line', async () => {
  const { receiptEmail } = await import('../server/emails/receipt.js');
  const r = { ...paidPickup(), fulfillment: { type: 'shipping' }, address: { line1: '1 Main St', line2: 'Apt <2>', city: 'Toronto', region: 'Ontario', postalCode: 'M5V 2T6', country: 'CA' } };
  const { html } = receiptEmail(r, 'https://evincus.shop');
  for (const s of ['1 Main St', 'Apt &lt;2&gt;', 'Toronto', 'Ontario', 'M5V 2T6', 'Canada', "We'll contact you about shipping cost and timing"]) assert.ok(html.includes(s), s);
  assert.ok(!html.includes('TrendyHatz'));
});

test('a legacy not-collected order still renders in the receipt and the summary rows', async () => {
  const { receiptEmail } = await import('../server/emails/receipt.js');
  const { recordRows, revealOrder } = await import('../server/lib/orders.js');
  const legacy = { ...paidPickup(), paymentStatus: 'NOT_COLLECTED', payment: undefined, taxCents: undefined, feeCents: undefined, taxBps: undefined, feeBps: undefined, totalCents: 6998,
    customer: { name: 'Ann Lee', email: 'ann@example.com', phone: '+1 555 123 4567' }, payer: { name: 'Ann Lee', email: 'ann@example.com' }, address: undefined, notes: 'hi' };
  const shown = await revealOrder(makeEnv(), legacy);
  assert.ok(receiptEmail(shown, 'https://evincus.shop').html.includes('$69.98 USD'));
  const rows = recordRows(shown);
  assert.ok(rows.some(([k, v]) => k === 'Customer' && v === 'Ann Lee <ann@example.com>'));
  assert.ok(!rows.some(([k]) => k.startsWith('GCT')));
});
