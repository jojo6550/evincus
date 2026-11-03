// Pays a placed order end to end through the routes: start payment, then WiPay's signed success return.
import { createHash } from 'node:crypto';
import { call } from './fake-env.mjs';
import { NOW } from './fixture.mjs';
import { formatTotal } from '../../server/lib/wipay.js';

export const WIPAY = { WIPAY_ACCOUNT_NUMBER: '1234567890', WIPAY_API_KEY: '123', WIPAY_ENVIRONMENT: 'sandbox', API_URL: 'https://api.test' };

// Needs fakeUpstreams() (its WiPay host) and an env with WIPAY. -> the transaction ID.
export async function payOrder(env, id, { clock = () => NOW } = {}) {
  await call('POST', `/api/orders/${id}/pay`, { body: {}, env, clock });
  const aid = JSON.parse(env.ORDERS.store.get(`order:${id}`).value).attemptId;
  const { totalCents } = JSON.parse(env.ORDERS.store.get(`payment-attempt:${aid}`).value);
  const txn = `SB-12-1-${aid}-20261024120000`;
  const hash = createHash('md5').update(txn + formatTotal(totalCents) + env.WIPAY_API_KEY).digest('hex');
  const r = await call('GET', `/api/payments/wipay/return?status=success&transaction_id=${txn}&order_id=${aid}&total=${formatTotal(totalCents)}&currency=USD&hash=${hash}`, { env, clock });
  if (!r.res.headers.get('location').endsWith('checkout=paid')) throw new Error(`payment did not go through for ${id}`);
  return txn;
}
