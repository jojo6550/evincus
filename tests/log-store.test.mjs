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
  env.ORDERS.put = () => new Promise(() => {}); // a store that never answers
  const ctx = { ...makeCtx(), waitUntil: () => {} };
  const res = await Promise.race([
    createApp().fetch(new Request('https://api.test/api/inventory/me'), env, ctx),
    new Promise((_, no) => setTimeout(() => no(new Error('request waited for the sink')), 1000)),
  ]);
  assert.equal(res.status, 401);
  const broken = env0();
  broken.ORDERS.failPuts = k => k.startsWith('log:');
  const r = await call('POST', '/api/inventory/login', { env: broken, ip: '8.8.8.8', body: { email: 'nobody@evincus.shop', password: 'x'.repeat(12) } });
  assert.ok(r.status >= 400 && r.status < 500);
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
  env.ORDERS.failGets = k => k === 'cron:lastRun';
  env.DISK_FREE = () => { throw new Error('statfs'); };
  const part = await h();
  assert.equal(part.lastCronAt, 'unknown');
  assert.equal(part.diskFreeBytes, 'unknown');
  assert.equal(part.emailRetryCount, 1);
}));
