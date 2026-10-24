import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readJson } from '../server/lib/http.js';
import { clientIp } from '../server/lib/client-ip.js';
import { fileAccess } from '../server/lib/files.js';
import { serveStatic } from '../server/static.js';
import { redact } from '../server/lib/log.js';
import { call, fakeLimiter, makeEnv } from './helpers/fake-env.mjs';
import { sendEmail } from '../server/lib/email.js';
import { api, ApiError } from '../assets/js/api.js';

test('stream limit cancels unknown-length bodies before consuming the rest', async () => {
  let pulls = 0, cancelled = false;
  const body = new ReadableStream({
    pull(c) { pulls++; c.enqueue(new Uint8Array(1024)); },
    cancel() { cancelled = true; },
  });
  await assert.rejects(readJson(new Request('http://test', { method: 'POST', body, duplex: 'half' }), 2048), e => e.status === 413);
  assert.equal(cancelled, true);
  assert.ok(pulls <= 5);
});

test('stream parsing counts bytes and preserves split multibyte characters', async () => {
  const bytes = new TextEncoder().encode('{"x":"é"}');
  const req = () => new Request('http://test', { method: 'POST', duplex: 'half', body: new ReadableStream({ start(c) { for (const byte of bytes) c.enqueue(Uint8Array.of(byte)); c.close(); } }) });
  assert.deepEqual(await readJson(req(), bytes.length), { x: 'é' });
  await assert.rejects(readJson(req(), bytes.length - 1), e => e.status === 413);
});

test('forwarded headers are ignored on direct connections; Render adapter validates its documented first entry', () => {
  const req = { socket: { remoteAddress: '::ffff:127.0.0.1' }, headers: { 'x-forwarded-for': '1.2.3.4, 10.0.0.1', 'cf-connecting-ip': '9.9.9.9' } };
  assert.equal(clientIp(req, {}), '127.0.0.1');
  assert.equal(clientIp(req, { RENDER: 'false' }), '127.0.0.1');
  assert.equal(clientIp(req, { RENDER: 'true' }), '1.2.3.4');
  req.headers['x-forwarded-for'] = 'garbage, 1.2.3.4';
  assert.equal(clientIp(req, { RENDER: 'true' }), '127.0.0.1');
  req.headers['x-forwarded-for'] = '2001:0db8:0000::1';
  assert.equal(clientIp(req, { RENDER: 'true' }), '2001:db8::1');
});

test('quote and admin limits reject requests before reading storage or catalog', async () => {
  const env = makeEnv({ QUOTE_LIMIT: fakeLimiter(1), ADMIN_LIMIT: fakeLimiter(1), ADMIN_TOKEN: 'test' });
  assert.equal((await call('POST', '/api/bag/quote', { env, body: {} })).status, 400);
  env.ORDERS.failGets = () => true;
  const limited = await call('POST', '/api/bag/quote', { env, body: {} });
  assert.equal(limited.status, 429);
  assert.equal(limited.res.headers.get('retry-after'), '60');
  assert.equal((await call('GET', '/api/admin/sales', { env })).status, 401);
  assert.equal((await call('GET', '/api/admin/sales', { env })).status, 429);
  const down = makeEnv({ QUOTE_LIMIT: { async limit() { throw new Error('unavailable'); } } });
  assert.equal((await call('POST', '/api/bag/quote', { env: down, body: {} })).status, 503);
});

test('security headers cover API, errors, static pages and method failures', async () => {
  const env = makeEnv({ SITE_URL: 'https://shop.test', CSP_MODE: 'enforce' });
  const responses = [
    (await call('GET', '/api/health', { env })).res,
    (await call('GET', '/api/missing', { env })).res,
    await serveStatic(new Request('https://shop.test/'), { env, readFile: async () => 'home' }),
    await serveStatic(new Request('https://shop.test/', { method: 'POST' }), { env, readFile: async () => 'home' }),
  ];
  for (const res of responses) {
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
    assert.match(res.headers.get('content-security-policy'), /script-src 'self'/);
    assert.match(res.headers.get('strict-transport-security'), /max-age=31536000/);
  }
});

test('conditional and HEAD requests avoid file reads and invalidation serves fresh content', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'evincus-files-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'index.html'), 'before');
  const files = fileAccess(dir, { maxBytes: 20 });
  let reads = 0;
  const options = { ...files, readFile: async (...args) => { reads++; return files.readFile(...args); } };
  const first = await serveStatic(new Request('https://test/'), options);
  assert.equal(await first.text(), 'before');
  const etag = first.headers.get('etag');
  const unchanged = await serveStatic(new Request('https://test/', { headers: { 'If-None-Match': etag } }), options);
  assert.equal(unchanged.status, 304);
  const head = await serveStatic(new Request('https://test/', { method: 'HEAD' }), options);
  assert.equal(head.headers.get('content-length'), '6');
  assert.equal(reads, 1);
  await writeFile(join(dir, 'index.html'), 'after change');
  assert.equal(await (await serveStatic(new Request('https://test/'), options)).text(), 'after change');
});

test('logs strip nested customer data and credentials, including tokens in strings', () => {
  const clean = redact({ Authorization: 'Bearer secret', customer: { name: 'Ann' }, notes: 'private', reqId: '123', nested: { RESEND_API_KEY: 'secret', message: 'mail ann@example.com https://test/?t=secret Bearer token' } });
  assert.deepEqual(Object.keys(clean), ['reqId', 'nested']);
  assert.doesNotMatch(JSON.stringify(clean), /ann@example|secret|Bearer token/);
});

test('test/restore email guards stop outbound requests', async () => {
  await assert.rejects(sendEmail({ EMAIL_DISABLED: 'true' }, { to: 'test@example.com' }), /disabled/);
  await assert.rejects(sendEmail({ EMAIL_TEST_RECIPIENT: 'test@example.com', RESEND_API_KEY: 'fake' }, { to: 'real@example.com' }), /blocked/);
});

test('a truncated successful response stays uncertain instead of acknowledging checkout', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response('{"id":', { status: 201, headers: { 'Content-Type': 'application/json' } });
    await assert.rejects(api('POST', '/api/orders', {}), e => e instanceof ApiError && e.status === 0);
  } finally { globalThis.fetch = original; }
});
