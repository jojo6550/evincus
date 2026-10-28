import test from 'node:test';
import assert from 'node:assert/strict';
import { api, ApiError, newOpId, onSignedOut } from '../assets/js/inventory-api.js';

const stub = (status, body) => {
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }); };
  return calls;
};

test('api adds opId to writes and reports 401 as signed-out', async () => {
  const calls = stub(200, { ok: true });
  await api('POST', '/api/inventory/x', { a: 1 }, { opId: 'op-1' });
  assert.equal(calls[0].init.credentials, 'same-origin');
  assert.deepEqual(JSON.parse(calls[0].init.body), { a: 1, opId: 'op-1' });
  await api('GET', '/api/inventory/x');
  assert.equal(calls[1].init.body, undefined);

  let signedOut = 0;
  onSignedOut(() => signedOut++);
  stub(401, { error: { code: 'signed-out', message: 'Sign in.', requestId: 'r1' } });
  await assert.rejects(api('GET', '/api/inventory/me'), e => e instanceof ApiError && e.status === 401 && e.code === 'signed-out');
  assert.equal(signedOut, 1);

  stub(400, { error: { code: 'bad', message: 'Nope', details: [1] } });
  await assert.rejects(api('POST', '/x', {}), e => e.code === 'bad' && e.details[0] === 1);
  assert.match(newOpId(), /^[0-9a-f-]{36}$/);
});
