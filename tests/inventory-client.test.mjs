import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { api, ApiError, newOpId, onSignedOut } from '../assets/js/inventory-api.js';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const stub = (status, body) => {
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }); };
  return calls;
};
const sentBody = call => JSON.parse(call.init.body);

test('api adds opId to writes and reports 401 as signed-out', async () => {
  const calls = stub(200, { ok: true });
  await api('POST', '/api/inventory/x', { a: 1 }, { opId: 'op-1' });
  assert.equal(calls[0].init.credentials, 'same-origin');
  assert.deepEqual(sentBody(calls[0]), { a: 1, opId: 'op-1' });
  await api('GET', '/api/inventory/x');
  assert.equal(calls[1].init.body, undefined);

  let signedOut = 0;
  const off = onSignedOut(() => signedOut++);
  stub(401, { error: { code: 'signed-out', message: 'Sign in.', requestId: 'r1' } });
  await assert.rejects(api('GET', '/api/inventory/me'), e => e instanceof ApiError && e.status === 401 && e.code === 'signed-out');
  assert.equal(signedOut, 1);

  stub(400, { error: { code: 'bad', message: 'Nope', details: [1] } });
  await assert.rejects(api('POST', '/x', {}), e => e.code === 'bad' && e.details[0] === 1);
  assert.equal(signedOut, 1);
  assert.match(newOpId(), /^[0-9a-f-]{36}$/);
  off();
});

test('writes get a fresh opId unless the caller passes one', async () => {
  const calls = stub(200, { ok: true });
  await api('POST', '/x', { a: 1 });
  await api('POST', '/x');
  await api('PUT', '/x', {}, { opId: 'retry' });
  assert.match(sentBody(calls[0]).opId, /^[0-9a-f-]{36}$/);
  assert.match(sentBody(calls[1]).opId, /^[0-9a-f-]{36}$/);
  assert.notEqual(sentBody(calls[0]).opId, sentBody(calls[1]).opId);
  assert.equal(sentBody(calls[2]).opId, 'retry');
});

test('a 401 from the login route is not signed-out; one from anywhere else is', async () => {
  let signedOut = 0;
  const off = onSignedOut(() => signedOut++);
  stub(401, { error: { code: 'login-failed', message: 'Wrong.', requestId: 'r' } });
  await assert.rejects(api('POST', '/api/inventory/login', { email: 'a', password: 'b' }), e => e.code === 'login-failed');
  assert.equal(signedOut, 0);
  stub(401, { error: { code: 'signed-out', message: 'Sign in.', requestId: 'r' } });
  await assert.rejects(api('POST', '/api/inventory/products', {}), e => e.code === 'signed-out');
  assert.equal(signedOut, 1);
  off();
});

test('a request that outlasts its timeout ends as a network error; the default is 30 s', { timeout: 2000 }, async t => {
  const signals = [];
  const hold = setInterval(() => {}, 1000); // AbortSignal.timeout's timer is unref'd and alone would let Node exit
  t.after(() => clearInterval(hold));
  globalThis.fetch = (url, init) => new Promise((resolve, reject) => {
    signals.push(init.signal);
    init.signal.addEventListener('abort', () => reject(init.signal.reason));
  });
  await assert.rejects(api('POST', '/x', {}, { timeout: 5 }), e => e instanceof ApiError && e.status === 0 && e.code === 'network');
  assert.equal(signals[0].aborted, true);
  api('GET', '/x').catch(() => {}); // never settles in this test; only its signal is inspected
  assert.equal(signals[1].aborted, false);
});
