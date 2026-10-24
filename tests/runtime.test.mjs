import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { request } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { gunzipSync, brotliDecompressSync } from 'node:zlib';

async function start(t, file) {
  const child = fork(new URL('../main.js', import.meta.url), [], { silent: true, execArgv: [], env: { ...process.env, PORT: '0', ENVIRONMENT: 'development', KV_PATH: file, EMAIL_DISABLED: 'true', NEWSLETTER_HOUR: '', KEEPALIVE_URL: '', CSP_MODE: 'enforce' } });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let logs = '', errors = '';
  child.stderr.on('data', value => { errors += value; });
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Server startup timed out: ${errors}`)), 15000);
    child.stdout.on('data', chunk => {
      logs += chunk;
      const match = /"event":"runtime.listening"[^\n]*"port":(\d+)/.exec(logs);
      if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); }
    });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Server exited ${code}: ${errors}`)); });
  });
  return { child, url, stop: async () => { const done = once(child, 'exit'); child.send('shutdown'); const [code] = await done; assert.equal(code, 0); } };
}

test('real HTTP adapter serves compressed content, conditional requests, streaming 413 and persists KV across shutdown', { timeout: 60000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'evincus-runtime-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'kv.sqlite3');
  const app = await start(t, file);
  for (const encoding of ['gzip', 'br']) {
    await new Promise((resolve, reject) => {
      const req = request(app.url + '/', { headers: { 'Accept-Encoding': encoding } }, res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
          try {
            assert.equal(res.headers['content-encoding'], encoding);
            assert.match(res.headers.vary, /Accept-Encoding/);
            const body = (encoding === 'gzip' ? gunzipSync : brotliDecompressSync)(Buffer.concat(chunks));
            assert.match(body.toString(), /Evincus Streetwear/); resolve();
          } catch (error) { reject(error); }
        });
      }).on('error', reject);
      req.setTimeout(5000, () => req.destroy(new Error('HTTP request timed out'))); req.end();
    });
  }
  const first = await fetch(app.url + '/assets/js/index.js');
  const revalidated = await fetch(app.url + '/assets/js/index.js', { headers: { 'If-None-Match': first.headers.get('etag') } });
  assert.equal(revalidated.status, 304);
  assert.match(revalidated.headers.get('vary'), /Accept-Encoding/);
  const head = await fetch(app.url + '/', { method: 'HEAD', headers: { 'Accept-Encoding': 'gzip' } });
  assert.match(head.headers.get('vary'), /Accept-Encoding/);
  assert.equal(head.headers.get('content-encoding'), 'gzip');
  await first.arrayBuffer();
  assert.equal((await fetch(app.url + '/api/newsletter/subscribe', { method: 'POST', body: 'x'.repeat(4096) })).status, 413);
  await new Promise((resolve, reject) => {
    const req = request(app.url + '/api/newsletter/subscribe', { method: 'POST', headers: { 'Transfer-Encoding': 'chunked' } }, res => {
      res.resume(); res.on('end', () => { try { assert.equal(res.statusCode, 413); resolve(); } catch (e) { reject(e); } });
    });
    req.setTimeout(5000, () => req.destroy(new Error('HTTP request timed out')));
    req.on('error', reject); req.write('x'.repeat(4096)); req.end();
  });
  assert.equal((await fetch(app.url + '/.env')).status, 404);
  assert.equal((await fetch(app.url + '/__error/503')).status, 503);
  const health = await (await fetch(app.url + '/api/health')).json();
  assert.equal(health.ok, true);
  assert.equal(health.operations.disk, 'ok');
  const list = await (await fetch(app.url + '/api/eras')).json();
  let product;
  for (const era of list.eras.filter(e => e.status === 'live')) {
    const detail = await (await fetch(app.url + '/api/eras/' + era.slug)).json();
    product ??= detail.products.find(p => p.buyable && !p.soldOut && !p.soldOutVariants.length);
  }
  assert.ok(product);
  const payload = { checkoutToken: crypto.randomUUID(), items: [{ id: product.id, color: product.colors[0].name, size: product.sizes[0], qty: 1 }], customer: { name: 'Test Shopper', email: 'isolated@example.com', phone: '5551234567' }, fulfillment: { type: 'pickup', locationId: 'trendy-hats' }, expectedTotalCents: product.priceCents };
  const submit = base => fetch(base + '/api/orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  const order = await (await submit(app.url)).json();
  assert.equal(order.paymentStatus, 'NOT_COLLECTED');
  await app.stop();
  const restarted = await start(t, file);
  assert.equal((await (await submit(restarted.url)).json()).id, order.id);
  await restarted.stop();
});
