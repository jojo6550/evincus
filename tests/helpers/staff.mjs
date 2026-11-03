import { call } from './fake-env.mjs';
import { hashPassword, accountKey } from '../../server/lib/accounts.js';

export const ADMIN_TOKEN = 'admin-test-token';
const SALT = Buffer.from('0123456789abcdef').toString('base64');
const PW = 'correct horse 1';
const HASH = await hashPassword(PW, SALT);

// Creates an account through the admin API, signs in, and returns its session cookie. env needs ADMIN_TOKEN.
export async function signIn(env, role = 'owner', email = `${role}@evincus.shop`) {
  const put = await call('PUT', '/api/admin/accounts', { env, headers: { Authorization: `Bearer ${ADMIN_TOKEN}` }, body: { email, salt: SALT, hash: HASH, iterations: 600000, role } });
  if (put.status !== 200) throw new Error('account setup failed');
  // Skip the first-login password change; inventory-auth tests cover it.
  const key = accountKey(email);
  const { mustChange: _, ...account } = JSON.parse(env.ORDERS.store.get(key).value);
  await env.ORDERS.put(key, JSON.stringify(account));
  const r = await call('POST', '/api/inventory/login', { env, ip: '8.8.8.8', body: { email, password: PW } });
  return r.res.headers.get('set-cookie').split(';')[0];
}

// A same-origin write, as the inventory page sends it.
export const post = (env, cookie, path, body, headers = {}) =>
  call('POST', path, { env, body, headers: { cookie, origin: 'https://api.test', ...headers } });
