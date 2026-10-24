import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { serveStatic, ERROR_CODES } from '../server/static.js';
import { captureLogs } from './helpers/fake-env.mjs';

const FILES = {
  'index.html': 'home', 'eras.html': 'eras', '404.html': 'not found', '500.html': 'broken', '503.html': 'down',
  'assets/css/index.css': 'body{}', 'assets/js/config.js': 'FROM DISK', 'assets/fonts/CruJones.ttf': 'font',
  'data/site.json': '{}', 'data/eras/core/img/core-tee-black-1.jpg': 'jpg', 'assets/.hidden': 'x',
  'assets/img/favicon.ico': 'icon',
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
    ['/assets/css/index.css', 'text/css; charset=utf-8', 'public, max-age=600'],
    ['/assets/fonts/CruJones.ttf', 'font/ttf', 'public, max-age=2592000'],
    ['/data/site.json', 'application/json; charset=utf-8', 'public, max-age=600'],
    ['/data/eras/core/img/core-tee-black-1.jpg', 'image/jpeg', 'public, max-age=600'],
  ]) {
    const r = await get(path);
    assert.equal(r.status, 200, path);
    assert.equal(r.headers.get('content-type'), type, path);
    assert.equal(r.headers.get('cache-control'), cache, path);
  }
});

test('nothing outside the allowlist is served, however the path is written', async () => {
  for (const path of ['/README.md', '/server/index.js', '/.env', '/package.json', '/assets/.hidden', '/assets/%2e%2e%2f.env',
    '/assets/..%5c.env', '/data/%00x', '/assets/', '/assets', '/nope.html', '/INDEX.HTML', '/assets//css/index.css', '/%E0%A4%A',
    '/assets/%252e%252e/package.json', '/assets/%252e%252e/%252eenv', '/data/%252e./package.json', '/assets/%2e%2e/package.json']) {
    const r = await get(path);
    assert.equal(r.status, 404, path);
    assert.equal(await r.text(), 'not found', path);
  }
});

test('the conventional favicon URL serves the current icon, including HEAD requests', async () => {
  const response = await get('/favicon.ico');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/x-icon');
  assert.equal(await response.text(), 'icon');
  const head = await get('/favicon.ico', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-type'), 'image/x-icon');
  assert.equal(await head.text(), '');
});

test('config.js is generated from env, never read from disk', async () => {
  const r = await get('/assets/js/config.js');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'text/javascript; charset=utf-8');
  assert.equal(await r.text(), `export const API_BASE = '';\n`);
  // A case-insensitive filesystem would otherwise resolve this to the stale file on disk.
  const cased = await get('/assets/JS/config.js');
  assert.equal(cased.status, 200);
  const casedBody = await cased.text();
  assert.match(casedBody, /API_BASE = ''/);
  assert.notEqual(casedBody, 'FROM DISK');
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
  const logs = captureLogs();
  try {
    const r = await get('/assets/explode.css');
    assert.equal(r.status, 500);
    assert.equal(await r.text(), 'broken');
  } finally {
    logs.restore();
  }
  assert.ok(logs.lines.some(line => line.event === 'static.failed' && line.level === 'error'));
});

test('traversal stays blocked when files resolve through file URLs, as in production', async () => {
  // Resolves like Deno's new URL(path, import.meta.url) plus percent-decoding, then reads from FILES.
  const urlRead = async path => {
    const u = new URL(path, 'file:///root/');
    const rel = decodeURIComponent(u.pathname).slice('/root/'.length);
    return readFile(rel);
  };
  const via = p => serveStatic(new Request(`https://shop.test${p}`), { env: {}, readFile: urlRead });
  for (const p of ['/assets/%252e%252e/package.json', '/assets/%252e%252e/%252eenv', '/data/%252e./package.json', '/assets/%252e%252e/server/index.js']) {
    const r = await via(p);
    assert.equal(r.status, 404, p);
    assert.equal(await r.text(), 'not found', p);
  }
  assert.equal((await via('/assets/css/index.css')).status, 200);
});

test('every real error page resolves links from the site root', () => {
  for (const code of ERROR_CODES) assert.match(readFileSync(new URL(`../${code}.html`, import.meta.url), 'utf8'), /<base href="\/">/, `${code}.html`);
});

test('robots.txt allows crawling only on the live domain, whatever ENVIRONMENT says, and points at the sitemap', async () => {
  const robots = host => serveStatic(new Request('https://shop.test/robots.txt', { headers: host ? { host } : {} }), { env: {}, readFile });
  for (const host of ['www.evincus.shop', 'evincus.shop', 'WWW.Evincus.shop:443']) {
    const r = await robots(host);
    assert.equal(r.headers.get('content-type'), 'text/plain; charset=utf-8');
    const text = await r.text();
    assert.match(text, /^Allow: \/$/m, host);
    assert.match(text, /^Disallow: \/api\/$/m, host);
    assert.match(text, /^Sitemap: https:\/\/www\.evincus\.shop\/sitemap\.xml$/m, host);
  }
  for (const host of ['evincus-dev.onrender.com', 'localhost:8000', 'evincus.shop.evil.test', null]) {
    assert.match(await (await robots(host)).text(), /^Disallow: \/$/m, String(host));
  }
});

test('sitemap.xml lists released products with their images and hides unreleased ones', async () => {
  const data = {
    eras: [{ slug: 'live', name: 'Live', dropsAt: null, endsAt: null }, { slug: 'soon', name: 'Soon', dropsAt: '2999-01-01T00:00:00Z', endsAt: null }],
    products: [
      { id: 'shown-tee', era: 'live', sizes: ['M'], colors: [{ name: 'Black', images: ['data/eras/live/img/a.jpg'] }] },
      { id: 'secret-tee', era: 'soon', sizes: ['M'], colors: [{ name: 'Black' }] },
    ],
  };
  const r = await serveStatic(new Request('https://shop.test/sitemap.xml'), { env: {}, readFile, data });
  assert.equal(r.headers.get('content-type'), 'application/xml; charset=utf-8');
  const xml = await r.text();
  assert.match(xml, /<loc>https:\/\/www\.evincus\.shop\/products\/shown-tee<\/loc>/);
  assert.match(xml, /<image:loc>https:\/\/www\.evincus\.shop\/data\/eras\/live\/img\/a\.jpg<\/image:loc>/);
  assert.doesNotMatch(xml, /secret-tee/);
});

test('/products/<id> serves the storefront with that product in the head, and 404s unknown ids', async () => {
  const page = { 'index.html': '<head><!-- seo --><title>Home</title><!-- /seo --></head>shop', '404.html': 'not found' };
  const readPage = async path => { if (!(path in page)) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); return new TextEncoder().encode(page[path]); };
  const r = await serveStatic(new Request('https://shop.test/products/disaster-zone-tee'), { env: {}, readFile: readPage });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'text/html; charset=utf-8');
  const html = await r.text();
  assert.match(html, /<title>Disaster Zone Tee \| Evincus Streetwear<\/title>/);
  assert.match(html, /<link rel="canonical" href="https:\/\/www\.evincus\.shop\/products\/disaster-zone-tee">/);
  assert.doesNotMatch(html, /<title>Home<\/title>/);
  assert.match(html, /shop$/);
  const ld = JSON.parse(/<script type="application\/ld\+json">(.*?)<\/script>/.exec(html)[1]);
  assert.equal(ld['@type'], 'Product');
  assert.equal(ld.offers.price, '34.99');
  assert.equal(ld.offers.priceCurrency, 'USD');
  assert.equal(ld.offers.availability, 'https://schema.org/InStock');
  assert.equal(ld.brand.name, 'Evincus Streetwear');
  for (const path of ['/products/nope', '/products/', '/products/disaster-zone-tee/x']) {
    assert.equal((await serveStatic(new Request(`https://shop.test${path}`), { env: {}, readFile: readPage })).status, 404, path);
  }
});

test('pages name the speculation rules, which prefetch site links but never API or product URLs', async () => {
  assert.equal((await get('/')).headers.get('speculation-rules'), '"/speculation-rules.json"');
  assert.equal((await get('/nope.html')).headers.get('speculation-rules'), null);
  assert.equal((await get('/assets/css/index.css')).headers.get('speculation-rules'), null);
  const r = await get('/speculation-rules.json');
  assert.equal(r.headers.get('content-type'), 'application/speculationrules+json');
  const rules = await r.json();
  assert.equal(rules.prerender, undefined);
  assert.deepEqual(rules.prefetch[0].where.and[1].not.href_matches, ['/api/*', '/products/*', '/newsletter.html']);
});

test('STATUS closes the public domain with a 503 page, never the onrender.com dev link', async () => {
  const pages = { ...FILES, 'newsletter.html': 'nl', 'restocking.html': 'restocking' };
  const at = (STATUS, host, path) => serveStatic(new Request(`https://${host}${path}`, { headers: { host } }), { env: { STATUS }, readFile: async p => new TextEncoder().encode(pages[p]) });
  for (const path of ['/', '/eras.html', '/products/x', '/robots.txt']) {
    const r = await at('stocking', 'WWW.Evincus.shop:443', path);
    assert.equal(r.status, 503, path);
    assert.equal(await r.text(), 'restocking', path);
    assert.equal(r.headers.get('cache-control'), 'no-store', path);
  }
  assert.equal(await (await at('maintenance', 'evincus.shop', '/')).text(), 'down');
  assert.equal(await (await at('stockng', 'evincus.shop', '/')).text(), 'down', 'a typo closes the store');
  assert.equal(await (await at('live', 'evincus.shop', '/')).text(), 'home');
  assert.equal((await at('stocking', 'evincus.shop', '/assets/css/index.css')).status, 200);
  assert.equal((await at('stocking', 'evincus.shop', '/newsletter.html')).status, 200);
  const dev = await at('stocking', 'evincus-dev.onrender.com', '/');
  assert.equal(dev.status, 200);
  assert.equal(await dev.text(), 'home');
  assert.equal((await get('/')).status, 200, 'unset STATUS is live');
});
