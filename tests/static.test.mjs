import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { serveStatic, ERROR_CODES } from '../server/static.js';

const FILES = {
  'index.html': 'home', 'eras.html': 'eras', '404.html': 'not found', '500.html': 'broken', '503.html': 'down',
  'assets/css/index.css': 'body{}', 'assets/js/config.js': 'FROM DISK', 'assets/fonts/CruJones.ttf': 'font',
  'data/site.json': '{}', 'data/eras/core/img/core-tee-black-1.jpg': 'jpg', 'assets/.hidden': 'x',
  'README.md': 'readme', 'server/index.js': 'code', '.env': 'ADMIN_TOKEN=x', 'package.json': '{}',
};
const readFile = async path => {
  if (path === 'assets/explode.css') throw Object.assign(new Error('disk on fire'), { code: 'EIO' });
  if (!(path in FILES)) throw Object.assign(new Error(`missing ${path}`), { code: 'ENOENT' });
  return new TextEncoder().encode(FILES[path]);
};
const get = (path, { method = 'GET', env = {} } = {}) => serveStatic(new Request(`https://shop.test${path}`, { method }), { env, readFile });

test('/ serves index.html as uncached HTML', async () => {
  const r = await get('/');
  assert.equal(r.status, 200);
  assert.equal(await r.text(), 'home');
  assert.equal(r.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.equal(r.headers.get('cache-control'), 'no-cache');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
});

test('root pages, assets and data are served with their types', async () => {
  for (const [path, type, cache] of [
    ['/eras.html', 'text/html; charset=utf-8', 'no-cache'],
    ['/assets/css/index.css', 'text/css; charset=utf-8', 'public, max-age=3600'],
    ['/assets/fonts/CruJones.ttf', 'font/ttf', 'public, max-age=3600'],
    ['/data/site.json', 'application/json; charset=utf-8', 'public, max-age=3600'],
    ['/data/eras/core/img/core-tee-black-1.jpg', 'image/jpeg', 'public, max-age=3600'],
  ]) {
    const r = await get(path);
    assert.equal(r.status, 200, path);
    assert.equal(r.headers.get('content-type'), type, path);
    assert.equal(r.headers.get('cache-control'), cache, path);
  }
});

test('nothing outside the allowlist is served, however the path is written', async () => {
  for (const path of ['/README.md', '/server/index.js', '/.env', '/package.json', '/assets/.hidden', '/assets/%2e%2e%2f.env',
    '/assets/..%5c.env', '/data/%00x', '/assets/', '/assets', '/nope.html', '/INDEX.HTML', '/assets//css/index.css', '/%E0%A4%A']) {
    const r = await get(path);
    assert.equal(r.status, 404, path);
    assert.equal(await r.text(), 'not found', path);
  }
});

test('config.js is generated from env, never read from disk', async () => {
  const r = await get('/assets/js/config.js', { env: { PAYPAL_CLIENT_ID: 'live-"id' } });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'text/javascript; charset=utf-8');
  assert.equal(await r.text(), `export const API_BASE = '';\nexport const PAYPAL_CLIENT_ID = "live-\\"id";\n`);
  assert.match(await (await get('/assets/js/config.js')).text(), /PAYPAL_CLIENT_ID = "test"/);
});

test('/__error/<code> shows that page only in development', async () => {
  const dev = await get('/__error/503', { env: { ENVIRONMENT: 'development' } });
  assert.equal(dev.status, 503);
  assert.equal(await dev.text(), 'down');
  assert.equal((await get('/__error/503', { env: { ENVIRONMENT: 'production' } })).status, 404);
  assert.equal((await get('/__error/418', { env: { ENVIRONMENT: 'development' } })).status, 404);
});

test('HEAD has headers and no body; other methods are 405', async () => {
  const head = await get('/', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  const post = await get('/', { method: 'POST' });
  assert.equal(post.status, 405);
  assert.equal(post.headers.get('allow'), 'GET, HEAD');
});

test('a disk error other than a missing file is a 500 page', async () => {
  const r = await get('/assets/explode.css');
  assert.equal(r.status, 500);
  assert.equal(await r.text(), 'broken');
});

test('every real error page resolves links from the site root', () => {
  for (const code of ERROR_CODES) assert.match(readFileSync(new URL(`../${code}.html`, import.meta.url), 'utf8'), /<base href="\/">/, `${code}.html`);
});
