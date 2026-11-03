import test from 'node:test';
import assert from 'node:assert/strict';
import { call, makeEnv, makeCtx, captureLogs, fakeLimiter } from './helpers/fake-env.mjs';
import { signIn } from './helpers/staff.mjs';
import { createApp } from '../server/index.js';
import { createLogger, shouldSave } from '../server/lib/log.js';
import { logSink } from '../server/lib/log-store.js';

const ADMIN = 'admin-test-token';
const env0 = over => makeEnv({ ADMIN_TOKEN: ADMIN, ...over });
const logKeys = env => [...env.ORDERS.store.keys()].filter(k => k.startsWith('log:'));
const quiet = fn => async () => { const cap = captureLogs(); try { await fn(cap); } finally { cap.restore(); } };

test('only the listed lines are saved, after redaction, with a 30-day TTL', quiet(async () => {
  const env = env0(), pending = [];
  const log = createLogger({ route: 'POST /x' }, { sink: logSink(env, p => pending.push(p)) });
  log.info('login.ok', { account: 'boss@evincus.shop', email: 'ann@example.com', note: 'mail ann@example.com' });
  log.info('cart.viewed');
  log.info('request', { status: 200 });
  log.error('unhandled', { message: 'x' });
  await Promise.all(pending);
  const keys = logKeys(env);
  assert.equal(keys.length, 2);
  const saved = keys.map(k => ({ ...JSON.parse(env.ORDERS.store.get(k).value), ttl: env.ORDERS.store.get(k).opts.expirationTtl }));
  const ok = saved.find(l => l.event === 'login.ok');
  assert.equal(ok.ttl, 2592000);
  assert.equal(ok.account, 'boss@evincus.shop'); // staff-only field keeps its email
  assert.equal(ok.email, undefined); // PII key dropped
  assert.equal(ok.note, 'mail [redacted-email]'); // everything else is masked
  assert.ok(saved.some(l => l.event === 'unhandled'));
  assert.ok(shouldSave({ level: 'error', event: 'request', status: 500 }));
  assert.ok(!shouldSave({ level: 'warn', event: 'request', status: 404 }));
}));

test('a failing sink never fails or delays the request', quiet(async () => {
  const env = env0();
  const put = env.ORDERS.put.bind(env.ORDERS);
  let hung = 0, released = false, release;
  const gate = new Promise(r => { release = () => { released = true; r(); }; });
  env.ORDERS.put = (k, ...a) => k.startsWith('log:') ? (hung++, gate) : put(k, ...a); // the log store answers only on release()
  const ctx = { ...makeCtx(), waitUntil: () => {} };
  // No timing race: a response that waited on the put could only arrive after release(), which the assert below catches.
  // The safety release only stops a broken build from hanging until the test timeout (a 600k-round PBKDF2 can be slow).
  const safety = setTimeout(release, 60000);
  const res = await createApp().fetch(new Request('https://api.test/api/inventory/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'nobody@evincus.shop', password: 'x'.repeat(12) }) }), env, ctx);
  clearTimeout(safety);
  assert.equal(released, false, 'the response arrived while the log put was still pending');
  release();
  assert.equal(res.status, 401);
  assert.ok(hung > 0, 'the sink ran');
  const broken = env0();
  broken.ORDERS.failPuts = k => k.startsWith('log:');
  const r = await call('POST', '/api/inventory/login', { env: broken, ip: '8.8.8.8', body: { email: 'nobody@evincus.shop', password: 'x'.repeat(12) } });
  assert.ok(r.status >= 400 && r.status < 500);
}));

test('only a 500 request line is saved: closed-store, health and busy 503s are not', quiet(async () => {
  const env = env0({ STATUS: 'stocking' });
  for (let i = 0; i < 50; i++) assert.equal((await call('GET', '/api/eras', { env, headers: { host: 'evincus.shop' } })).status, 503);
  assert.deepEqual(logKeys(env), []);
  const busy = env0();
  busy.ORDERS.commit = async () => false;
  const order = { checkoutToken: crypto.randomUUID(), items: [{ id: 'alpha-tee', color: 'Black, white print', size: 'S', qty: 2 }], customer: { firstName: 'Ann', lastName: 'Lee', email: 'ann@example.com', phone: '+1 555 123 4567' }, fulfillment: { type: 'pickup', locationId: 'trendy-hats' }, expectedTotalCents: 8437 };
  const r = await call('POST', '/api/orders', { env: busy, body: order });
  assert.deepEqual([r.status, r.json.error.code], [503, 'busy']);
  assert.deepEqual(logKeys(busy), []);
  assert.ok(!shouldSave({ level: 'error', event: 'request', status: 503 }));
  assert.ok(!shouldSave({ level: 'warn', event: 'request', status: 429 }));
  const broken = env0();
  const r500 = await call('GET', '/api/eras', { env: broken, data: Promise.reject(new Error('boom')) });
  assert.equal(r500.status, 500);
  const saved = logKeys(broken).map(k => JSON.parse(broken.ORDERS.store.get(k).value));
  assert.ok(saved.some(l => l.event === 'request' && l.status === 500));
}));

test('bot 404s and 429s are not saved', quiet(async () => {
  const env = env0({ INVENTORY_LIMIT: fakeLimiter(0) });
  assert.equal((await call('GET', '/api/wp-login.php', { env })).status, 404);
  assert.equal((await call('GET', '/api/inventory/me', { env })).status, 429);
  assert.deepEqual(logKeys(env), []);
}));

test('logs and health are owner-only', quiet(async () => {
  const env = env0();
  const viewer = await signIn(env, 'viewer'), owner = await signIn(env, 'owner');
  for (const path of ['/api/inventory/logs', '/api/inventory/health']) {
    assert.equal((await call('GET', path, { env })).status, 401, path);
    assert.equal((await call('GET', path, { env, headers: { cookie: viewer } })).status, 403, path);
    assert.equal((await call('GET', path, { env, headers: { cookie: owner } })).status, 200, path);
  }
}));

test('no %40-encoded staff email reaches a log line; the route is a pattern', quiet(async cap => {
  const env = env0();
  await signIn(env, 'viewer', 'boss@evincus.shop');
  const r = await call('DELETE', '/api/admin/accounts/boss%40evincus.shop', { env, headers: { Authorization: `Bearer ${ADMIN}` } });
  assert.equal(r.status, 204);
  const saved = logKeys(env).map(k => env.ORDERS.store.get(k).value);
  for (const text of [...cap.lines.map(l => JSON.stringify(l)), ...saved]) assert.doesNotMatch(text, /%40/);
  assert.ok(cap.lines.some(l => l.route === 'DELETE /api/admin/accounts/:param'));
  const unmatched = captureLogs();
  await call('GET', '/api/x%40y.example.com', { env });
  unmatched.restore();
  assert.ok(!unmatched.lines.some(l => /%40|@y\.example/.test(JSON.stringify(l))));
}));

test('logs list newest first, 100 a page, filtered by level and kind', quiet(async () => {
  const env = env0();
  const owner = await signIn(env, 'owner');
  const put = (n, level, event) => env.ORDERS.put(`log:2026-10-03T10:${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}.000Z:aaaa`, JSON.stringify({ level, event, n }), { metadata: { l: level, e: event } });
  for (let i = 0; i < 205; i++) await put(i, i % 5 === 0 ? 'warn' : 'info', i % 2 ? 'order.placed' : 'login.ok');
  const get = q => call('GET', `/api/inventory/logs${q}`, { env, headers: { cookie: owner } });
  const p1 = (await get('')).json, p2 = (await get(`?before=${encodeURIComponent(p1.next)}`)).json, p3 = (await get(`?before=${encodeURIComponent(p2.next)}`)).json;
  assert.deepEqual([p1.logs.length, p2.logs.length, p3.logs.length, p3.next], [100, 100, 5, null]);
  assert.deepEqual([...p1.logs, ...p2.logs, ...p3.logs].map(l => l.n), Array.from({ length: 205 }, (_, i) => 204 - i));
  assert.ok((await get('?kind=order')).json.logs.every(l => l.event.startsWith('order')));
  assert.ok((await get('?level=warn')).json.logs.every(l => l.level === 'warn'));
  assert.equal((await get('?level=bogus')).status, 400);
}));

test('health reports each piece, and unknown for one that fails', quiet(async () => {
  const env = env0();
  env.DISK_FREE = () => 12345;
  await env.ORDERS.put('catalog:rev', JSON.stringify({ rev: 'rev-123' }));
  env.MEDIA.files.set('a'.repeat(24) + '-480.webp', new Uint8Array(10));
  await env.ORDERS.put('cron:lastRun', '2026-10-03T10:00:00.000Z');
  await env.ORDERS.put('email-retry:EV-1', '1');
  await env.ORDERS.put('digest-sent:2026-10-01', 'sent');
  await env.ORDERS.put('digest-sent:2026-10-02', 'sent');
  const owner = await signIn(env, 'owner');
  const h = async () => (await call('GET', '/api/inventory/health', { env, headers: { cookie: owner } })).json;
  const full = await h();
  assert.equal(full.diskFreeBytes, 12345);
  assert.equal(full.mediaBytes, 10);
  assert.equal(full.lastCronAt, '2026-10-03T10:00:00.000Z');
  assert.equal(full.emailRetryCount, 1);
  assert.equal(full.lastDigestDay, '2026-10-02');
  assert.equal(typeof full.commit, 'string');
  assert.equal(full.rev, 'rev-123');
  env.ORDERS.failGets = k => k === 'cron:lastRun';
  env.DISK_FREE = () => { throw new Error('statfs'); };
  const part = await h();
  assert.equal(part.lastCronAt, 'unknown');
  assert.equal(part.diskFreeBytes, 'unknown');
  assert.equal(part.emailRetryCount, 1);
}));

test('flood-prone events: anonymous login.blocked once per IP window, no client.error, disk_low hourly', quiet(async () => {
  assert.ok(!shouldSave({ level: 'warn', event: 'client.error' }));
  assert.ok(!shouldSave({ level: 'warn', event: 'login.blocked', account: null, firstBlock: false }));
  assert.ok(shouldSave({ level: 'warn', event: 'login.blocked', account: null, firstBlock: true }));
  assert.ok(!shouldSave({ level: 'warn', event: 'login.blocked', account: 'boss@evincus.shop', firstBlock: false }));
  assert.ok(shouldSave({ level: 'warn', event: 'login.blocked', account: 'boss@evincus.shop', firstBlock: true }));
  const env = env0();
  await signIn(env, 'owner');
  env.LOGIN_IP_LIMIT = fakeLimiter(0);
  const attempt = email => call('POST', '/api/inventory/login', { env, ip: '9.9.9.9', body: { email, password: 'x'.repeat(12) } });
  for (let i = 0; i < 5; i++) assert.equal((await attempt('nobody@evincus.shop')).status, 429);
  const blocked = () => logKeys(env).map(k => JSON.parse(env.ORDERS.store.get(k).value)).filter(l => l.event === 'login.blocked');
  assert.equal(blocked().length, 1);
  for (let i = 0; i < 5; i++) await attempt('owner@evincus.shop');
  assert.equal(blocked().length, 2, 'a known account is saved once per IP + account window too');
  assert.ok(blocked().some(l => l.account === 'owner@evincus.shop'));
  assert.equal(env.ORDERS.store.get('loginblock:9.9.9.9:owner@evincus.shop').opts.expirationTtl, 900);
  await call('POST', '/api/inventory/login', { env, ip: '7.7.7.7', body: { email: 'owner@evincus.shop', password: 'x'.repeat(12) } });
  assert.equal(blocked().length, 3, 'another IP gets its own row');
  const pending = [], log = createLogger({}, { sink: logSink(env, p => pending.push(p)) });
  for (let i = 0; i < 4; i++) log.error('operations.disk_low');
  await Promise.all(pending);
  assert.equal(logKeys(env).filter(k => JSON.parse(env.ORDERS.store.get(k).value).event === 'operations.disk_low').length, 1);
}));

test('paging crosses a day boundary newest first; a bad before date is 400', quiet(async () => {
  const env = env0();
  const owner = await signIn(env, 'owner');
  const put = (day, n) => env.ORDERS.put(`log:${day}T10:00:${String(n % 60).padStart(2, '0')}.${String(Math.floor(n / 60)).padStart(3, '0')}Z:aaaa`, JSON.stringify({ level: 'info', event: 'login.ok', day, n }), { metadata: { l: 'info', e: 'login.ok' } });
  for (let i = 0; i < 60; i++) { await put('2026-10-02', i); await put('2026-10-03', i); }
  const get = q => call('GET', `/api/inventory/logs${q}`, { env, headers: { cookie: owner } });
  const p1 = (await get('')).json, p2 = (await get(`?before=${encodeURIComponent(p1.next)}`)).json;
  assert.deepEqual([p1.logs.length, p2.logs.length, p2.next], [100, 20, null]);
  assert.deepEqual([...p1.logs, ...p2.logs].map(l => l.day), [...Array(60).fill('2026-10-03'), ...Array(60).fill('2026-10-02')]);
  assert.equal((await get('?before=log:2026-13-45T00:00:00.000Z:x')).status, 400);
}));
