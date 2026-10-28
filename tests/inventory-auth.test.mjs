import test from 'node:test';
import assert from 'node:assert/strict';
import { call, makeEnv, captureLogs, fakeLimiter } from './helpers/fake-env.mjs';
import { NOW } from './helpers/fixture.mjs';
import { hashPassword, requireStaff, startSession, accountKey } from '../server/lib/accounts.js';

const TOKEN = 'admin-test-token';
const SALT = Buffer.from('0123456789abcdef').toString('base64');
const PW = 'correct horse 1';
const HASH = await hashPassword(PW, SALT);
const auth = { Authorization: `Bearer ${TOKEN}` };
const env0 = over => makeEnv({ ADMIN_TOKEN: TOKEN, ...over });
const putAcct = (env, over = {}) => call('PUT', '/api/admin/accounts', { env, headers: auth, body: { email: 'Boss@Evincus.shop', salt: SALT, hash: HASH, iterations: 600000, ...over } });
const login = (env, email = 'boss@evincus.shop', password = PW, ip = '1.1.1.1') => call('POST', '/api/inventory/login', { env, ip, body: { email, password } });
const cookieOf = r => r.res.headers.get('set-cookie').split(';')[0];
const me = (env, cookie) => call('GET', '/api/inventory/me', { env, headers: { cookie } });
const stored = (env, email = 'boss@evincus.shop') => JSON.parse(env.ORDERS.store.get(accountKey(email)).value);

test('login sets an HttpOnly SameSite=Strict cookie and me returns the role', async () => {
  const env = env0();
  const put = await putAcct(env, { role: 'owner' });
  assert.deepEqual(put.json, { email: 'boss@evincus.shop', role: 'owner', created: true });
  const r = await login(env, ' BOSS@evincus.shop ');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { email: 'boss@evincus.shop', role: 'owner' });
  const sc = r.res.headers.get('set-cookie');
  assert.match(sc, /HttpOnly/);
  assert.match(sc, /SameSite=Strict/);
  assert.deepEqual((await me(env, cookieOf(r))).json, { email: 'boss@evincus.shop', role: 'owner', local: false });
  assert.equal((await call('GET', '/api/inventory/me', { env })).status, 401);
});

test('me says local in development', async () => {
  const env = env0({ ENVIRONMENT: 'development' });
  await putAcct(env);
  const r = await login(env);
  assert.equal((await me(env, cookieOf(r))).json.local, true);
});

test('wrong password and unknown email give the same 401 body', async () => {
  const env = env0();
  await putAcct(env);
  const a = await login(env, 'boss@evincus.shop', 'nope');
  const b = await login(env, 'ghost@evincus.shop', PW);
  assert.equal(a.status, 401);
  assert.equal(b.status, 401);
  assert.equal(a.json.error.code, 'login-failed');
  assert.equal(a.json.error.message, "That email and password don't match an account.");
  assert.deepEqual([a.json.error.code, a.json.error.message], [b.json.error.code, b.json.error.message]);
});

test('the 6th attempt for one email and the 11th from one IP are 429, logged login.blocked, and skip PBKDF2', async () => {
  const env = env0();
  await putAcct(env);
  const logs = captureLogs();
  const orig = crypto.subtle.deriveBits;
  let derives = 0;
  crypto.subtle.deriveBits = function (...a) { derives++; return orig.apply(this, a); };
  try {
    for (let i = 0; i < 5; i++) assert.equal((await login(env, 'Boss@evincus.shop', 'bad')).status, 401);
    assert.equal(derives, 5);
    const six = await login(env, ' boss@EVINCUS.shop', PW);
    assert.equal(six.status, 429);
    assert.equal(six.json.error.code, 'rate-limited');
    assert.equal(derives, 5);
    for (let i = 0; i < 10; i++) await login(env, `u${i}@x.test`, 'bad', '9.9.9.9');
    derives = 0;
    const eleven = await login(env, 'u99@x.test', 'bad', '9.9.9.9');
    assert.equal(eleven.status, 429);
    assert.equal(derives, 0);
  } finally { crypto.subtle.deriveBits = orig; logs.restore(); }
  assert.equal(logs.lines.filter(l => l.event === 'login.blocked').length, 2);
});

test('re-adding an account bumps epoch and signs its sessions out, keeping the role', async () => {
  const env = env0();
  await putAcct(env, { role: 'owner' });
  const cookie = cookieOf(await login(env));
  assert.equal((await me(env, cookie)).status, 200);
  assert.deepEqual((await putAcct(env)).json, { email: 'boss@evincus.shop', role: 'owner', created: false });
  assert.equal(stored(env).epoch, NOW + 1);
  assert.equal((await me(env, cookie)).status, 401);
  assert.equal((await putAcct(env, { role: 'viewer' })).json.role, 'viewer');
});

test('a new account defaults to viewer with a timestamp epoch and createdAt', async () => {
  const env = env0();
  assert.equal((await putAcct(env)).json.role, 'viewer');
  const a = stored(env);
  assert.equal(a.epoch, NOW);
  assert.ok(a.createdAt);
});

test('delete then re-add never revives an old session, and 2,000,000 iterations is the cap', async () => {
  const env = env0();
  await putAcct(env);
  const cookie = cookieOf(await login(env));
  assert.equal((await me(env, cookie)).status, 200);
  await call('DELETE', '/api/admin/accounts/boss%40evincus.shop', { env, headers: auth });
  const hash2 = await hashPassword('another pw 2', SALT);
  const re = await call('PUT', '/api/admin/accounts', { env, headers: auth, clock: () => NOW + 1000, body: { email: 'boss@evincus.shop', salt: SALT, hash: hash2, iterations: 600000 } });
  assert.equal(re.status, 200);
  assert.equal((await me(env, cookie)).status, 401);
  assert.equal((await putAcct(env, { iterations: 2000000 })).status, 200);
});

test('login logs never contain a typed email that has no account', async () => {
  const env = env0();
  await putAcct(env);
  const logs = captureLogs();
  try {
    await login(env, 'ghost@nowhere.test', 'hunter2-secret');
    await login(env, 'boss@evincus.shop', 'bad');
    await login(env, 'boss@evincus.shop');
  } finally { logs.restore(); }
  const all = JSON.stringify(logs.lines);
  assert.ok(!all.includes('ghost@nowhere.test'));
  assert.ok(!all.includes('hunter2-secret'));
  const failed = logs.lines.filter(l => l.event === 'login.failed');
  assert.equal(failed.length, 2);
  assert.equal(failed[0].account, null);
  assert.ok(failed[1].account); // log redaction masks the address itself
  assert.ok(logs.lines.find(l => l.event === 'login.ok')?.account);
});

test('login success records lastLoginAt, and a failing write does not fail the login', async () => {
  const env = env0();
  await putAcct(env);
  assert.equal((await login(env)).status, 200);
  assert.equal(stored(env).lastLoginAt, new Date(NOW).toISOString());
  env.ORDERS.commit = async () => { throw new Error('boom'); };
  assert.equal((await login(env, 'boss@evincus.shop', PW, '2.2.2.2')).status, 200);
});

test('logout deletes the session, clears the cookie, and is 204 even when signed out', async () => {
  const env = env0();
  await putAcct(env);
  const cookie = cookieOf(await login(env));
  const out = await call('POST', '/api/inventory/logout', { env, headers: { cookie } });
  assert.equal(out.status, 204);
  assert.match(out.res.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await me(env, cookie)).status, 401);
  assert.equal([...env.ORDERS.store.keys()].filter(k => k.startsWith('session:')).length, 0);
  const again = await call('POST', '/api/inventory/logout', { env });
  assert.equal(again.status, 204);
  assert.match(again.res.headers.get('set-cookie'), /Max-Age=0/);
});

test('requireStaff checks expiry against c.now', async () => {
  const env = env0();
  await putAcct(env);
  const t = await startSession(env, stored(env), 1000);
  const req = new Request('https://api.test/x', { headers: { cookie: `evincus_inv=${t}` } });
  assert.ok(await requireStaff(req, { env, now: new Date(1000 + 604799000) }));
  await assert.rejects(requireStaff(req, { env, now: new Date(1000 + 604800000) }), { code: 'signed-out' });
});

test('PUT /api/admin/accounts validates input', async () => {
  const env = env0();
  const bad = [{ email: 'nope' }, { email: 'a'.repeat(250) + '@x.co' }, { role: 'admin' }, { salt: '!!!' }, { hash: 'abc' }, { iterations: 1000 }, { iterations: 600000.5 }, { iterations: 2000001 }, { iterations: '600000' }, { salt: undefined }];
  for (const over of bad) assert.equal((await putAcct(env, over)).status, 400, JSON.stringify(over));
  assert.equal((await call('PUT', '/api/admin/accounts', { env, body: {} })).status, 401);
  assert.equal([...env.ORDERS.store.keys()].filter(k => k.startsWith('account:')).length, 0);
});

test('GET and DELETE accounts', async () => {
  const env = env0();
  await putAcct(env, { role: 'owner' });
  await putAcct(env, { email: 'v@evincus.shop' });
  const list = await call('GET', '/api/admin/accounts', { env, headers: auth });
  assert.deepEqual(list.json.accounts.map(a => a.email).sort(), ['boss@evincus.shop', 'v@evincus.shop']);
  assert.deepEqual(Object.keys(list.json.accounts[0]).sort(), ['createdAt', 'email', 'lastLoginAt', 'role']);
  assert.ok(!list.text.includes(HASH));
  assert.equal((await call('DELETE', '/api/admin/accounts/' + encodeURIComponent('V@evincus.shop'), { env, headers: auth })).status, 204);
  assert.equal((await call('DELETE', '/api/admin/accounts/' + encodeURIComponent('v@evincus.shop'), { env, headers: auth })).json.error.code, 'not-found');
  assert.equal((await call('DELETE', '/api/admin/accounts/%E0%A4%A', { env, headers: auth })).status, 404);
});

test('INVENTORY_LIMIT applies to every /api/inventory route', async () => {
  const env = env0({ INVENTORY_LIMIT: fakeLimiter(1) });
  assert.equal((await call('GET', '/api/inventory/me', { env })).status, 401);
  assert.equal((await call('GET', '/api/inventory/me', { env })).status, 429);
});

test('inventory and admin APIs answer while STATUS=stocking on evincus.shop', async () => {
  const env = env0({ STATUS: 'stocking' });
  const headers = { host: 'evincus.shop' };
  assert.equal((await call('GET', '/api/inventory/me', { env, headers })).status, 401);
  assert.equal((await call('GET', '/api/admin/accounts', { env, headers: { ...headers, ...auth } })).status, 200);
  assert.equal((await call('GET', '/api/catalog', { env, headers })).status, 503);
});
