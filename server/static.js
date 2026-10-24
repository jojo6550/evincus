import { createLogger } from './lib/log.js';
import { secureResponse } from './lib/security.js';
import { CATALOG } from './lib/catalog.js';
import { loadSales } from './lib/sales.js';
import { applySales, publicView } from '../data/catalog.js';
import { robotsTxt, sitemapXml, productHead, crawlable } from './lib/seo.js';
import { siteStatus } from './lib/http.js';

// The public site: root .html pages, /assets/ and /data/. Nothing else in the repo (server code, docs, .env,
// package files) is ever served. Missing pages get 404.html with a real 404 status.
export const ERROR_CODES = [403, 404, 500, 502, 503, 504];

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.mp4': 'video/mp4', '.avif': 'image/avif',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
};
const PAGE = /^\/[a-z0-9-]+\.html$/;
const DIRS = ['/assets/', '/data/'];
const MISSING = new Set(['ENOENT', 'EISDIR', 'EACCES', 'EPERM', 'NotFound', 'IsADirectory', 'PermissionDenied']);

const extension = path => /\.[a-z0-9]+$/i.exec(path)?.[0].toLowerCase() ?? '';
const missing = err => MISSING.has(err?.code) || MISSING.has(err?.name);

// The path is decoded once before this check, so a still-encoded %2e would pass and later be decoded again by a file URL.
function allowed(path) {
  if (!/^[A-Za-z0-9._\/-]+$/.test(path)) return false;
  if (/\.\.|\\|\0|\/\//.test(path) || path.split('/').some(part => part.startsWith('.'))) return false;
  return PAGE.test(path) || DIRS.some(dir => path.startsWith(dir) && !path.endsWith('/'));
}

// Pages linked from the current one are fetched when a visitor hovers or touches the link, so the click is served
// from memory. Prefetch, never prerender: a prerendered page would run its scripts early and show a stale cart.
const SPECULATION_RULES = JSON.stringify({
  prefetch: [{ where: { and: [{ href_matches: '/*' }, { not: { href_matches: ['/api/*', '/products/*', '/newsletter.html'] } }] }, eagerness: 'moderate' }],
});

// The site's runtime settings. The API is same-origin, so API_BASE is always ''.
const configJs = env => `export const API_BASE = '';\nexport const PAYPAL_CLIENT_ID = ${JSON.stringify(env.PAYPAL_CLIENT_ID ?? 'test')};\n`;

// /products/<id>: the storefront with that product's title, description, social card and Product JSON-LD in the
// <head>, so search engines and link previews see the product. The page's own script opens the product view.
async function productPage(id, { env, readFile, data, now }) {
  const sales = env.ORDERS ? await loadSales(env, createLogger({ route: 'GET product page' })) : [];
  const view = publicView(applySales(data, sales, now), now);
  const p = view.products.find(x => x.id === id);
  if (!p) return null;
  const html = new TextDecoder().decode(await readFile('index.html'));
  return html.replace(/<!-- seo -->[\s\S]*?<!-- \/seo -->/, productHead(p, view.eras.find(e => e.slug === p.era)));
}

async function staticResponse(req, { env = {}, readFile, statFile, data = CATALOG, now = new Date() }) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } });
  const send = (body, path, status = 200, cache = extension(path) === '.html' ? 'no-cache' : 'public, max-age=600') =>
    new Response(req.method === 'HEAD' ? null : body, {
      status,
      headers: {
        'Content-Type': path === '/speculation-rules.json' ? 'application/speculationrules+json' : TYPES[extension(path)] ?? 'application/octet-stream',
        'Cache-Control': cache, 'X-Content-Type-Options': 'nosniff',
        ...(extension(path) === '.html' && status === 200 && { 'Speculation-Rules': '"/speculation-rules.json"' }),
      },
    });
  const errorPage = async code => send(await readFile(`${code}.html`), `${code}.html`, code, 'no-store');

  try {
    let path;
    try { path = decodeURIComponent(new URL(req.url).pathname); } catch { return await errorPage(404); }
    if (path === '/') path = '/index.html';
    if (path === '/favicon.ico') path = '/assets/img/favicon.ico';
    // Assets stay up for the 503 page itself; newsletter.html so unsubscribe links in sent emails keep working.
    const status = siteStatus(req, env);
    if (status !== 'live' && !path.startsWith('/assets/') && path !== '/newsletter.html') {
      const page = status === 'stocking' ? 'restocking.html' : '503.html';
      return send(await readFile(page), page, 503, 'no-store');
    }
    if (path.toLowerCase() === '/assets/js/config.js') return send(configJs(env), '/assets/js/config.js', 200, 'no-cache');
    if (path === '/robots.txt') return send(robotsTxt(crawlable(req.headers.get('host'))), path, 200, 'public, max-age=3600');
    if (path === '/sitemap.xml') return send(sitemapXml(data, now), path, 200, 'public, max-age=3600');
    if (path === '/speculation-rules.json') return send(SPECULATION_RULES, path, 200, 'public, max-age=3600');
    const product = /^\/products\/([a-z0-9-]+)$/.exec(path);
    if (product) {
      const html = await productPage(product[1], { env, readFile, data, now });
      return html ? send(html, '/index.html') : await errorPage(404);
    }
    const forced = /^\/__error\/(\d{3})$/.exec(path);
    if (forced && env.ENVIRONMENT === 'development' && ERROR_CODES.includes(Number(forced[1]))) return await errorPage(Number(forced[1]));
    if (allowed(path)) {
      try {
        const file = path.slice(1);
        const info = await statFile?.(file);
        const noneMatch = req.headers.get('if-none-match');
        const unchanged = info && (noneMatch
          ? noneMatch.split(',').some(tag => tag.trim() === '*' || tag.trim().replace(/^W\//, '') === info.etag.replace(/^W\//, ''))
          : req.headers.get('if-modified-since') && Date.parse(req.headers.get('if-modified-since')) >= Date.parse(info.modified));
        // Responsive photos are named by content hash. Fonts get a new filename whenever one is replaced.
        const cache = /^\/assets\/img\/responsive\/[a-f0-9]{16}-\d+\.webp$/.test(path) ? 'public, max-age=31536000, immutable'
          : path.startsWith('/assets/fonts/') ? 'public, max-age=2592000' : undefined;
        const res = send(unchanged || (info && req.method === 'HEAD') ? null : await readFile(file, info), path, unchanged ? 304 : 200, cache);
        if (info) {
          res.headers.set('ETag', info.etag);
          res.headers.set('Last-Modified', info.modified);
          if (!unchanged) res.headers.set('Content-Length', String(info.size));
        }
        return res;
      }
      catch (err) { if (!missing(err)) throw err; }
    }
    return await errorPage(404);
  } catch (err) {
    createLogger({ route: `${req.method} static` }).error('static.failed', { message: String(err?.message ?? err) });
    try { return await errorPage(500); } catch { return new Response('Server error', { status: 500 }); }
  }
}

export async function serveStatic(req, options) {
  return secureResponse(await staticResponse(req, options), options.env);
}
