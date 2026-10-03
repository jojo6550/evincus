import test from 'node:test';
import assert from 'node:assert/strict';
import { call, makeEnv, makeCtx, fakeUpstreams, captureLogs } from './helpers/fake-env.mjs';
import { FIXTURE, NOW } from './helpers/fixture.mjs';
import { createApp } from '../worker/src/index.js';

const MIN = 60_000;
const item = { id: 'alpha-tee', color: 'Black, white print', size: 'S', qty: 2 };

async function buy(env) {
  const id = (await call('POST', '/api/orders', { body: { items: [item] }, env })).json.id;
  await call('POST', '/api/orders/capture', { body: { orderID: id }, env });
  return id;
}

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

test('after capture the customer gets a receipt and the owner a notification', async () => {
  const up = fakeUpstreams();
  const env = makeEnv();
  const id = await buy(env);
  const customer = up.emails.find(e => e.to[0] === 'ann@example.com');
  const owner = up.emails.find(e => e.to[0] === 'owner@evincus.shop');
  assert.equal(customer.subject, `Your Evincus order ${id}`);
  assert.equal(customer.idempotencyKey, `${id}-customer`);
  assert.ok(customer.html.includes('Alpha &lt;Tee&gt;'));
  assert.ok(!customer.html.includes('<Tee>'));
  assert.ok(customer.html.includes('$74.98'));
  assert.ok(customer.html.includes('1 Main St'));
  assert.match(owner.subject, new RegExp(`New order ${id}: \\$74\\.98`));
  assert.equal(owner.idempotencyKey, `${id}-owner`);
  assert.ok(owner.html.includes('ann@example.com'));
  assert.deepEqual(record(env, id).email, { customer: 'sent', owner: 'sent', attempts: 1 });
  assert.equal(retryState(env, id), undefined);
});

test('a failed receipt is queued for retry 15 minutes later; the owner email still goes', async () => {
  const up = fakeUpstreams({ resend: { fail: b => b.to[0] === 'ann@example.com' } });
  const env = makeEnv();
  const id = await buy(env);
  assert.deepEqual(record(env, id).email, { customer: 'failed', owner: 'sent', attempts: 1 });
  assert.deepEqual(retryState(env, id), { retries: 0, nextAt: NOW + 15 * MIN });
  assert.equal(up.emails.length, 1);
});

test('a capture with no payer email still succeeds; the owner is notified and the receipt retried', async () => {
  const up = fakeUpstreams({ paypal: { payer: { name: { given_name: 'Ann' } } } });
  const env = makeEnv();
  const id = await buy(env);
  assert.equal(record(env, id).email.customer, 'failed');
  assert.ok(up.emails.some(e => e.to[0] === 'owner@evincus.shop'));
  assert.ok(retryState(env, id));
});

test('cron waits until the retry is due, then resends only what failed', async () => {
  let failing = true;
  const up = fakeUpstreams({ resend: { fail: b => failing && b.to[0] === 'ann@example.com' } });
  const env = makeEnv();
  const id = await buy(env);
  await cron(env, NOW + 14 * MIN);
  assert.equal(up.emails.length, 1);
  failing = false;
  await cron(env, NOW + 15 * MIN);
  assert.deepEqual(up.emails.map(e => e.to[0]), ['owner@evincus.shop', 'ann@example.com']);
  assert.deepEqual(record(env, id).email, { customer: 'sent', owner: 'sent', attempts: 2 });
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
  for (const pii of ['ann@example.com', 'Ann Lee', '1 Main St', 'Kingston']) assert.ok(!all.includes(pii), pii);
});
