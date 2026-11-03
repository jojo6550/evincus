import test from 'node:test';
import assert from 'node:assert/strict';
import { seal, unseal, isSealed, validDataKey, dataKey } from '../server/lib/crypto.js';
import { makeEnv } from './helpers/fake-env.mjs';

const value = { customer: { email: 'ann@example.com' } };
const otherKey = () => Buffer.alloc(32, 9).toString('base64');

test('seal and unseal round trip', async () => {
  const env = makeEnv();
  const box = await seal(env, value);
  assert.equal(box.v, 1);
  assert.ok(isSealed(box));
  assert.deepEqual(await unseal(env, box), value);
});

test('two seals of one value differ and hide the plaintext', async () => {
  const env = makeEnv();
  const [a, b] = [await seal(env, value), await seal(env, value)];
  assert.notEqual(a.iv, b.iv);
  assert.ok(!JSON.stringify(a).includes('ann@example.com'));
});

test('a different key or tampered ciphertext rejects', async () => {
  const box = await seal(makeEnv(), value);
  await assert.rejects(unseal(makeEnv({ CUSTOMER_DATA_KEY: otherKey() }), box));
  const ct = Buffer.from(box.ct, 'base64'); ct[0] ^= 1;
  await assert.rejects(unseal(makeEnv(), { ...box, ct: ct.toString('base64') }));
});

test('validDataKey wants 32 bytes of base64', async () => {
  assert.equal(validDataKey(otherKey()), true);
  assert.equal(validDataKey(Buffer.alloc(31, 1).toString('base64')), false);
  assert.equal(validDataKey('not base64 !!'), false);
  assert.equal(validDataKey(undefined), false);
  await assert.rejects(dataKey({ CUSTOMER_DATA_KEY: 'short' }), /CUSTOMER_DATA_KEY must be 32 bytes, base64/);
});

test('isSealed only for envelopes', () => {
  assert.equal(isSealed(null), false);
  assert.equal(isSealed({ customer: {} }), false);
  assert.equal(isSealed({ v: 1, iv: 'a', ct: 'b' }), true);
});

test('logs drop sealed blobs, hashes and the new secrets', async () => {
  const { redact } = await import('../server/lib/log.js');
  assert.deepEqual(redact({ pii: { v: 1 }, hash: 'abc', WIPAY_API_KEY: '123', customer_data_key: 'k', orderId: 'EV-1' }), { orderId: 'EV-1' });
});
