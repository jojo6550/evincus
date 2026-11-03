import test from 'node:test';
import assert from 'node:assert/strict';
import { productionConfigErrors } from '../server/lib/startup.js';

const key = n => Buffer.alloc(32, n).toString('base64');
const valid = {
  ADMIN_TOKEN: 'a'.repeat(40), NEWSLETTER_KEY: 'n'.repeat(40), CUSTOMER_DATA_KEY: key(1),
  WIPAY_ENVIRONMENT: 'live', WIPAY_ACCOUNT_NUMBER: '4242424242', WIPAY_API_KEY: 'real-live-key-value',
};
const without = (...names) => Object.fromEntries(Object.entries(valid).filter(([k]) => !names.includes(k)));

test('a complete live setup has no errors', () => {
  assert.deepEqual(productionConfigErrors(valid), []);
});

test('the admin and newsletter secret rule is unchanged', () => {
  assert.equal(productionConfigErrors({ ...valid, ADMIN_TOKEN: 'short' }).length, 1);
  assert.equal(productionConfigErrors({ ...valid, NEWSLETTER_KEY: 'local-dev-only'.padEnd(40, 'x') }).length, 1);
  assert.equal(productionConfigErrors({ ...valid, NEWSLETTER_KEY: valid.ADMIN_TOKEN }).length, 1);
});

test('the customer data key must be a valid key, and not another secret', () => {
  for (const CUSTOMER_DATA_KEY of [undefined, '', Buffer.alloc(31, 1).toString('base64'), 'not base64 at all!!']) {
    assert.match(productionConfigErrors({ ...valid, CUSTOMER_DATA_KEY }).join(), /CUSTOMER_DATA_KEY/);
  }
  assert.match(productionConfigErrors({ ...valid, CUSTOMER_DATA_KEY: key(5), ADMIN_TOKEN: key(5) }).join(), /CUSTOMER_DATA_KEY/);
});

test('WiPay unset entirely is allowed: payments are off', () => {
  assert.deepEqual(productionConfigErrors(without('WIPAY_ENVIRONMENT', 'WIPAY_ACCOUNT_NUMBER', 'WIPAY_API_KEY')), []);
});

test('WiPay set with sandbox settings or the public test key refuses to start', () => {
  assert.match(productionConfigErrors({ ...valid, WIPAY_API_KEY: '123' }).join(), /WIPAY_API_KEY/);
  assert.match(productionConfigErrors(without('WIPAY_ENVIRONMENT')).join(), /WIPAY_ENVIRONMENT/);
  assert.match(productionConfigErrors({ ...valid, WIPAY_ENVIRONMENT: 'sandbox' }).join(), /WIPAY_ENVIRONMENT/);
  assert.match(productionConfigErrors(without('WIPAY_API_KEY')).join(), /WIPAY/);
});
