import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, fakeUpstreams, captureLogs, call } from './helpers/fake-env.mjs';
import { NOW } from './helpers/fixture.mjs';
import { createLogger } from '../worker/src/lib/log.js';
import { sendEmail } from '../worker/src/lib/email.js';
import { alert, countPaypalError } from '../worker/src/lib/alerts.js';

const ctxFor = (env, now = NOW) => ({ env, log: createLogger({}), now: new Date(now), reqId: 'req-1', waitUntil: () => {} });

test('sendEmail posts to Resend with the idempotency key', async () => {
  const up = fakeUpstreams();
  await sendEmail(makeEnv(), { to: 'a@b.c', subject: 'Hi', html: '<p>x</p>', idempotencyKey: 'k1' });
  assert.equal(up.emails.length, 1);
  assert.deepEqual(up.emails[0], { from: 'Evincus <orders@evincus.shop>', to: ['a@b.c'], subject: 'Hi', html: '<p>x</p>', idempotencyKey: 'k1' });
  assert.equal(up.calls[0].headers.get('Authorization'), 'Bearer re_test');
});

test('sendEmail throws when Resend fails or the address is missing', async () => {
  fakeUpstreams({ resend: { fail: () => true } });
  await assert.rejects(sendEmail(makeEnv(), { to: 'a@b.c', subject: 's', html: 'h', idempotencyKey: 'k' }));
  await assert.rejects(sendEmail(makeEnv(), { to: '', subject: 's', html: 'h', idempotencyKey: 'k' }));
});

test('alert emails the owner once per hour per event', async () => {
  const up = fakeUpstreams();
  const env = makeEnv();
  const logs = captureLogs();
  try {
    await alert(ctxFor(env), 'unhandled', { subject: 'Crash', rows: [['Message', 'boom']] });
    await alert(ctxFor(env), 'unhandled', { subject: 'Crash', rows: [['Message', 'boom']] });
  } finally { logs.restore(); }
  assert.equal(up.emails.length, 1);
  assert.deepEqual(up.emails[0].to, ['owner@evincus.shop']);
  assert.equal(up.emails[0].subject, '[Evincus alert] Crash');
  assert.equal(env.ORDERS.store.get('alert:unhandled').opts.expirationTtl, 3600);
  assert.ok(logs.lines.some(l => l.event === 'alert.sent'));
  assert.ok(logs.lines.some(l => l.event === 'alert.suppressed' && l.alertEvent === 'unhandled'));
});

test('alert with dedupe false always sends', async () => {
  const up = fakeUpstreams();
  const env = makeEnv();
  await alert(ctxFor(env), 'order.log_failed', { subject: 'A', dedupe: false });
  await alert(ctxFor(env), 'order.log_failed', { subject: 'B', dedupe: false });
  assert.equal(up.emails.length, 2);
});

test('alert never throws when Resend fails, and logs alert.failed', async () => {
  fakeUpstreams({ resend: { fail: () => true } });
  const logs = captureLogs();
  try { await alert(ctxFor(makeEnv()), 'unhandled', { subject: 'x' }); } finally { logs.restore(); }
  assert.ok(logs.lines.some(l => l.event === 'alert.failed'));
});

test('alert email escapes values', async () => {
  const up = fakeUpstreams();
  await alert(ctxFor(makeEnv()), 'unhandled', { subject: 'x', rows: [['Name', 'Alpha <Tee>']] });
  assert.ok(up.emails[0].html.includes('Alpha &lt;Tee&gt;'));
  assert.ok(!up.emails[0].html.includes('<Tee>'));
});

test('PayPal error burst alerts once at the 5th error in a 10-minute bucket', async () => {
  const up = fakeUpstreams();
  const env = makeEnv();
  for (let i = 0; i < 6; i++) await countPaypalError(ctxFor(env));
  assert.equal(up.emails.length, 1);
  assert.match(up.emails[0].subject, /PayPal/);
  const key = `paypal-errors:${Math.floor(NOW / 600000)}`;
  assert.equal(env.ORDERS.store.get(key).value, '6');
  assert.equal(env.ORDERS.store.get(key).opts.expirationTtl, 1200);
});

test('unhandled errors alert the owner', async () => {
  const up = fakeUpstreams();
  const logs = captureLogs();
  try { await call('GET', '/api/eras', { data: null }); } finally { logs.restore(); }
  assert.equal(up.emails.length, 1);
  assert.match(up.emails[0].subject, /Unhandled error/);
});
