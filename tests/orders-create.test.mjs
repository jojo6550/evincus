import test from 'node:test';
import assert from 'node:assert/strict';
import { call, makeEnv, fakeUpstreams, captureLogs } from './helpers/fake-env.mjs';
import { verifyTag } from '../server/lib/paypal.js';
import { FIXTURE, NOW } from './helpers/fixture.mjs';

const item = (over = {}) => ({ id: 'alpha-tee', color: 'Black, white print', size: 'S', qty: 2, ...over });
const create = (items, env = makeEnv()) => call('POST', '/api/orders', { body: { items }, env });

test('creates a PayPal order priced from the catalog with a server-signed tag', async () => {
  const up = fakeUpstreams();
  const env = makeEnv();
  const { status, json } = await create([item()], env);
  assert.equal(status, 200);
  const unit = up.orders.get(json.id).purchase_units[0];
  assert.deepEqual(unit.amount, {
    currency_code: 'USD', value: '74.98',
    breakdown: { item_total: { currency_code: 'USD', value: '69.98' }, shipping: { currency_code: 'USD', value: '5.00' } },
  });
  assert.deepEqual(unit.items, [{
    name: 'Alpha <Tee>', description: 'Black, white print / S', sku: 'alpha-tee|Black, white print|S', quantity: '2',
    unit_amount: { currency_code: 'USD', value: '34.99' }, category: 'PHYSICAL_GOODS',
  }]);
  assert.match(unit.custom_id, /^[0-9a-f]{24}\.[0-9a-f]{64}$/);
  assert.equal(await verifyTag(env, unit.custom_id, '74.98'), true);
  assert.equal(await verifyTag(env, unit.custom_id, '0.01'), false);
  assert.equal(await verifyTag(makeEnv({ ORDER_HMAC_KEY: 'other' }), unit.custom_id, '74.98'), false);
});

test('a bag that is not checkout-ready is 409 bag-changed with lines, and PayPal is not called', async () => {
  const up = fakeUpstreams();
  for (const items of [[item(), { id: 'old-tee', color: 'Black', size: 'M', qty: 1 }], [item({ qty: 11 })]]) {
    const { status, json } = await create(items);
    assert.equal(status, 409);
    assert.equal(json.error.code, 'bag-changed');
    assert.ok(Array.isArray(json.error.lines));
  }
  assert.equal(up.calls.length, 0);
});

test('malformed bags are 400 without calling PayPal', async () => {
  const up = fakeUpstreams();
  const { status } = await create([item({ qty: 'x' })]);
  assert.equal(status, 400);
  assert.equal(up.calls.length, 0);
});

test('PayPal outage is 502 paypal-error and is logged without PII', async () => {
  fakeUpstreams({ paypal: { down: true } });
  const logs = captureLogs();
  let r;
  try { r = await create([item()]); } finally { logs.restore(); }
  assert.equal(r.status, 502);
  assert.equal(r.json.error.code, 'paypal-error');
  const e = logs.lines.find(l => l.event === 'paypal.error');
  assert.equal(e.op, 'auth');
  assert.equal(e.upstreamStatus, 500);
  // Verify no PII in logs
  const logsStr = JSON.stringify(logs.lines);
  assert.equal(logsStr.includes('"payer"'), false);
  assert.equal(logsStr.includes('"email"'), false);
  assert.equal(logsStr.includes('"name"'), false);
});

test('five PayPal failures in ten minutes alert the owner once', async () => {
  const up = fakeUpstreams({ paypal: { down: true } });
  const env = makeEnv();
  const logs = captureLogs();
  try { for (let i = 0; i < 6; i++) await create([item()], env); } finally { logs.restore(); }
  assert.equal(up.emails.length, 1);
  assert.match(up.emails[0].subject, /PayPal errors/);
});

test('create-time 422 from PayPal is 502 paypal-error and is counted', async () => {
  const up = fakeUpstreams();
  const env = makeEnv();
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const u = new URL(typeof input === 'string' ? input : input.url);
    if (u.host.includes('paypal') && u.pathname === '/v2/checkout/orders' && init.method === 'POST') {
      return new Response(JSON.stringify({ name: 'UNPROCESSABLE_ENTITY' }), { status: 422, headers: { 'Content-Type': 'application/json' } });
    }
    return original(input, init);
  };
  try {
    const { status, json } = await call('POST', '/api/orders', { body: { items: [item()] }, env, clock: () => NOW });
    assert.equal(status, 502);
    assert.equal(json.error.code, 'paypal-error');
    // Verify counter was incremented
    const key = `paypal-errors:${Math.floor(NOW / 600000)}`;
    const count = await env.ORDERS.get(key);
    assert.ok(count);
  } finally {
    globalThis.fetch = original;
  }
});

test('network failure to PayPal is 502 paypal-error', async () => {
  const up = fakeUpstreams();
  const env = makeEnv();
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const u = new URL(typeof input === 'string' ? input : input.url);
    if (u.host.includes('paypal')) {
      throw new Error('Network error');
    }
    return original(input, init);
  };
  try {
    const logs = captureLogs();
    let r;
    try { r = await create([item()], env); } finally { logs.restore(); }
    assert.equal(r.status, 502);
    assert.equal(r.json.error.code, 'paypal-error');
    const e = logs.lines.find(l => l.event === 'paypal.error');
    assert.equal(e.upstreamStatus, 0);
  } finally {
    globalThis.fetch = original;
  }
});
