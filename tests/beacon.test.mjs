import test from 'node:test';
import assert from 'node:assert/strict';
import { call, makeEnv, captureLogs } from './helpers/fake-env.mjs';

const send = (body, env = makeEnv(), ip = '1.2.3.4') =>
  call('POST', '/api/beacon', { raw: typeof body === 'string' ? body : JSON.stringify(body), env, ip });

test('a valid beacon is logged as client.error and returns 204', async () => {
  const logs = captureLogs();
  let r;
  try { r = await send({ event: 'quote-failed', code: 'network', route: '#/checkout', reqId: 'abc' }); } finally { logs.restore(); }
  assert.equal(r.status, 204);
  const line = logs.lines.find(l => l.event === 'client.error');
  assert.deepEqual([line.level, line.clientEvent, line.code, line.clientRoute, line.clientReqId], ['warn', 'quote-failed', 'network', '#/checkout', 'abc']);
});

test('beacons sent as text/plain (navigator.sendBeacon) are accepted', async () => {
  const r = await call('POST', '/api/beacon', { raw: JSON.stringify({ event: 'api-unreachable' }), headers: { 'Content-Type': 'text/plain' } });
  assert.equal(r.status, 204);
});

test('unknown events, extra fields, long or non-string fields are 400', async () => {
  for (const body of [{ event: 'hack' }, { event: 'quote-failed', extra: 1 }, { event: 'quote-failed', code: 'x'.repeat(201) },
    { event: 'quote-failed', route: 5 }, [], 'nope']) {
    const r = await send(body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.json.error.code, 'invalid-beacon');
  }
});

test('beacons over 2 KB are 413', async () => {
  const r = await send({ event: 'quote-failed', code: 'x'.repeat(2100) });
  assert.equal(r.status, 413);
});

test('more than 10 beacons a minute from one IP are 429', async () => {
  const env = makeEnv();
  const statuses = [];
  for (let i = 0; i < 11; i++) statuses.push((await send({ event: 'api-unreachable' }, env)).status);
  assert.deepEqual(statuses, [...Array(10).fill(204), 429]);
  assert.equal((await send({ event: 'api-unreachable' }, env, '5.6.7.8')).status, 204);
});

test('the client IP comes from the connection, not a spoofable header', async () => {
  const env = makeEnv();
  for (let i = 0; i < 10; i++) await send({ event: 'api-unreachable' }, env);
  const spoofed = await call('POST', '/api/beacon', { raw: JSON.stringify({ event: 'api-unreachable' }), env, ip: '1.2.3.4', headers: { 'X-Forwarded-For': '9.9.9.9' } });
  assert.equal(spoofed.status, 429);
});
