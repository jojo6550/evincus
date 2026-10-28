import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv } from './helpers/fake-env.mjs';
import { HttpError } from '../server/lib/http.js';
import { ITERATIONS, accountKey, hashPassword, verifyLogin, startSession, sessionCookie, clearCookie, staffFrom, requireStaff, isHttps } from '../server/lib/accounts.js';

const SALT = Buffer.from('0123456789abcdef').toString('base64');
async function mkAccount(env, email, role, password = 'pw-correct') {
  const account = { email, role, salt: SALT, hash: await hashPassword(password, SALT), epoch: 1 };
  await env.ORDERS.put(accountKey(email), JSON.stringify(account));
  return account;
}
const reqWith = (token, headers = {}, url = 'https://api.test/inventory/x', method = 'POST') =>
  new Request(url, { method, headers: { cookie: `evincus_inv=${token}`, ...headers } });
const code = p => p.then(() => null, e => (e instanceof HttpError ? `${e.code}:${e.status}` : e));

test('hashPassword is PBKDF2-SHA256 with 600000 iterations', async () => {
  assert.equal(ITERATIONS, 600000);
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('pw'), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: Buffer.from(SALT, 'base64'), iterations: 600000 }, key, 256);
  assert.equal(await hashPassword('pw', SALT), Buffer.from(bits).toString('base64'));
});

test('verifyLogin accepts the right password, refuses a wrong one and an unknown email the same way', async () => {
  const env = makeEnv();
  await mkAccount(env, 'a@evincus.shop', 'owner');
  assert.equal((await verifyLogin(env, ' A@Evincus.shop ', 'pw-correct')).role, 'owner');
  assert.equal(await verifyLogin(env, 'a@evincus.shop', 'nope'), null);
  assert.equal(await verifyLogin(env, 'ghost@evincus.shop', 'pw-correct'), null);
});

test('a session survives until epoch changes, then staffFrom returns null', async () => {
  const env = makeEnv();
  const acct = await mkAccount(env, 'a@evincus.shop', 'owner');
  const token = await startSession(env, acct, Date.now());
  assert.match(token, /^[0-9a-f]{64}$/);
  const staff = await staffFrom(reqWith(token), env);
  assert.equal(staff.email, 'a@evincus.shop');
  assert.equal(staff.role, 'owner');
  assert.match(staff.sessionKey, /^session:[0-9a-f]{64}$/);
  assert.equal(env.ORDERS.store.get(staff.sessionKey).opts.expirationTtl, 604800);
  assert.equal(await staffFrom(new Request('https://api.test/x'), env), null);
  assert.equal(await staffFrom(reqWith('f'.repeat(64)), env), null);
  await env.ORDERS.put(accountKey(acct.email), JSON.stringify({ ...acct, epoch: 2 }));
  assert.equal(await staffFrom(reqWith(token), env), null);
});

test('requireStaff: viewer cannot write owner routes; a write needs a same-origin Origin', async () => {
  const env = makeEnv();
  const viewer = await mkAccount(env, 'v@evincus.shop', 'viewer');
  const owner = await mkAccount(env, 'o@evincus.shop', 'owner');
  const c = { env };
  const vt = await startSession(env, viewer, Date.now());
  const ot = await startSession(env, owner, Date.now());
  const ok = { origin: 'https://api.test' };
  assert.equal(await code(requireStaff(new Request('https://api.test/x'), c)), 'signed-out:401');
  assert.equal((await requireStaff(reqWith(vt, {}, undefined, 'GET'), c)).role, 'viewer');
  assert.equal(await code(requireStaff(reqWith(vt, ok), c, { role: 'owner' })), 'forbidden:403');
  assert.equal((await requireStaff(reqWith(ot, ok), c, { role: 'owner', write: true })).role, 'owner');
  assert.equal(await code(requireStaff(reqWith(ot), c, { write: true })), 'bad-origin:403');
  for (const origin of ['null', 'garbage', 'https://evil.test'])
    assert.equal(await code(requireStaff(reqWith(ot, { origin }), c, { write: true })), 'bad-origin:403');
});

test('production behind a proxy: Host and x-forwarded-proto decide origin and Secure', async () => {
  const env = makeEnv();
  const owner = await mkAccount(env, 'o@evincus.shop', 'owner');
  const t = await startSession(env, owner, Date.now());
  const prod = { host: 'evincus.shop', 'x-forwarded-proto': 'https', origin: 'https://evincus.shop' };
  const url = 'http://localhost/inventory/x';
  assert.equal((await requireStaff(reqWith(t, prod, url), { env }, { write: true })).email, 'o@evincus.shop');
  assert.equal(await code(requireStaff(reqWith(t, { ...prod, origin: 'https://evil.test' }, url), { env }, { write: true })), 'bad-origin:403');
  assert.equal(await code(requireStaff(reqWith(t, { ...prod, origin: 'http://evincus.shop' }, url), { env }, { write: true })), 'bad-origin:403');
  assert.equal(isHttps(reqWith(t, prod, url)), true);
  assert.equal(isHttps(reqWith(t, {}, url)), false);
  assert.equal(isHttps(reqWith(t, {}, 'https://api.test/x')), true);
});

test('sessionCookie adds Secure only over HTTPS', () => {
  assert.equal(sessionCookie('tok', false), 'evincus_inv=tok; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800');
  assert.equal(sessionCookie('tok', true), 'evincus_inv=tok; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800; Secure');
  assert.equal(clearCookie(true), 'evincus_inv=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0; Secure');
  assert.equal(clearCookie(false), 'evincus_inv=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
});
