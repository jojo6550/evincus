import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeUpstreams } from './helpers/fake-env.mjs';
import { wipayConfig, formatTotal, newAttemptId, validTransactionId, verifyHash, requestPayment } from '../server/lib/wipay.js';

const TXN = 'SB-12-1-Ab3dE5gH7jK9mN1p-20261024120000', ATTEMPT = 'Ab3dE5gH7jK9mN1p';
const good = { transactionId: TXN, totalCents: 8037, apiKey: '123', hash: '5e1ca2042ff319ac51d62da59889d89e' };
const config = wipayConfig({ WIPAY_ACCOUNT_NUMBER: '1234567890', WIPAY_API_KEY: '123', WIPAY_ENVIRONMENT: 'sandbox' });
const customer = { firstName: 'Ann', lastName: 'Lee', email: 'ann@example.com', phone: '+1 (555) 123-4567' };
const pay = (over = {}) => requestPayment(config, { attemptId: ATTEMPT, totalCents: 8437, customer, address: null, responseUrl: 'https://api.test/api/payments/wipay/return', version: 'abc1234', ...over });

test('totals format with integer math', () => {
  assert.equal(formatTotal(1005), '10.05'); assert.equal(formatTotal(5), '0.05'); assert.equal(formatTotal(12055), '120.55');
  assert.equal(formatTotal(0), '0.00'); assert.equal(formatTotal(100), '1.00');
});

test('hash verifies only for the exact transaction, total and key', () => {
  assert.equal(verifyHash(good), true);
  assert.equal(verifyHash({ ...good, totalCents: 8038 }), false);
  assert.equal(verifyHash({ ...good, apiKey: '124' }), false);
  assert.equal(verifyHash({ ...good, transactionId: TXN.replace('12-1', '12-2') }), false);
  assert.equal(verifyHash({ ...good, hash: good.hash.toUpperCase() }), false);
  assert.equal(verifyHash({ ...good, hash: '' }), false);
  assert.equal(verifyHash({ ...good, hash: good.hash.slice(1) }), false);
  assert.equal(verifyHash({ ...good, hash: undefined }), false);
});

test('transaction IDs must match the environment and the attempt', () => {
  assert.equal(validTransactionId(TXN, ATTEMPT, 'sandbox'), true);
  assert.equal(validTransactionId(TXN, ATTEMPT, 'live'), false);
  assert.equal(validTransactionId(TXN.slice(3), ATTEMPT, 'live'), true);
  assert.equal(validTransactionId('SB-12-1-OTHERattempt00001-20261024120000', ATTEMPT, 'sandbox'), false);
  assert.equal(validTransactionId(`${TXN}x`, ATTEMPT, 'sandbox'), false);
  assert.equal(validTransactionId(undefined, ATTEMPT, 'sandbox'), false);
});

test('attempt IDs are 16 letters and digits', () => {
  const ids = new Set(Array.from({ length: 50 }, newAttemptId));
  assert.equal(ids.size, 50);
  for (const id of ids) assert.match(id, /^[A-Za-z0-9]{16}$/);
});

test('config is null without an account or key, and sandbox by default', () => {
  assert.equal(wipayConfig({ WIPAY_API_KEY: '123' }), null);
  assert.equal(wipayConfig({ WIPAY_ACCOUNT_NUMBER: '1234567890' }), null);
  assert.deepEqual(wipayConfig({ WIPAY_ACCOUNT_NUMBER: '1234567890', WIPAY_API_KEY: '123' }), { base: 'https://jmsb.wipayfinancial.com', environment: 'sandbox', accountNumber: 1234567890, apiKey: '123' });
  assert.equal(wipayConfig({ WIPAY_ACCOUNT_NUMBER: '1', WIPAY_API_KEY: 'k', WIPAY_ENVIRONMENT: 'live' }).base, 'https://jm.wipayfinancial.com');
});

test('requestPayment sends the documented fields and no address', async () => {
  const up = fakeUpstreams({ wipay: {} });
  const out = await pay({ address: { line1: '1 Main St', city: 'Toronto', country: 'CA' } });
  assert.deepEqual(out, { url: 'https://jmsb.wipayfinancial.com/checkout/payment?x=1', transactionId: `SB-12-1-${ATTEMPT}-20261024120000` });
  const [req] = up.wipay;
  assert.equal(req.host, 'jmsb.wipayfinancial.com');
  assert.equal(req.headers.get('Accept'), 'application/json');
  assert.deepEqual(req.body, {
    account_number: 1234567890, country_code: 'JM', currency: 'USD', environment: 'sandbox', fee_structure: 'merchant_absorb',
    method: 'credit_card_co', order_id: ATTEMPT, origin: 'evincus', response_url: 'https://api.test/api/payments/wipay/return',
    total: '84.37', email: 'ann@example.com', fname: 'Ann', lname: 'Lee', phone: '+15551234567', country: 'CA', version: 'abc1234',
  });
});

test('phone is sent only when it is E.164 after stripping punctuation; country defaults to JM', async () => {
  const up = fakeUpstreams({ wipay: {} });
  for (const phone of ['5551234567', '+1234567', '+1 234 567 890 123 456', '']) await pay({ customer: { ...customer, phone } });
  assert.ok(up.wipay.every(r => !('phone' in r.body) && r.body.country === 'JM'));
  await pay({ customer: { ...customer, phone: '+876.555.0142' } });
  assert.equal(up.wipay.at(-1).body.phone, '+8765550142');
});

test('a failed request is payment-unavailable', async () => {
  for (const reply of [() => ({ status: 400, body: { message: 'bad' } }), () => ({ body: { message: 'OK' } }), () => ({ body: { url: 'javascript:alert(1)' } }), () => { throw new Error('down'); }]) {
    fakeUpstreams({ wipay: { reply } });
    await assert.rejects(pay(), e => e.code === 'payment-unavailable' && e.status === 502);
  }
});
