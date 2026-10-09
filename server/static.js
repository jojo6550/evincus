import { createLogger } from './lib/log.js';

// The public site: root .html pages, /assets/ and /data/. Nothing else in the repo (server code, docs, .env,
// package files) is ever served. Missing pages get 404.html with a real 404 status.
export const ERROR_CODES = [403, 404, 500, 502, 503, 504];

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.mp4': 'video/mp4',
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

// The site's runtime settings. The API is same-origin, so API_BASE is always ''.
const configJs = env => `export const API_BASE = '';\nexport const PAYPAL_CLIENT_ID = ${JSON.stringify(env.PAYPAL_CLIENT_ID ?? 'test')};\n`;

export async function serveStatic(req, { env = {}, readFile }) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } });
  const send = (body, path, status = 200, cache = extension(path) === '.html' ? 'no-cache' : 'public, max-age=3600') =>
    new Response(req.method === 'HEAD' ? null : body, {
      status,
      headers: { 'Content-Type': TYPES[extension(path)] ?? 'application/octet-stream', 'Cache-Control': cache, 'X-Content-Type-Options': 'nosniff' },
    });
  const errorPage = async code => send(await readFile(`${code}.html`), `${code}.html`, code, 'no-store');

  try {
    let path;
    try { path = decodeURIComponent(new URL(req.url).pathname); } catch { return await errorPage(404); }
    if (path === '/') path = '/index.html';
    if (path.toLowerCase() === '/assets/js/config.js') return send(configJs(env), '/assets/js/config.js', 200, 'no-cache');
    const forced = /^\/__error\/(\d{3})$/.exec(path);
    if (forced && env.ENVIRONMENT === 'development' && ERROR_CODES.includes(Number(forced[1]))) return await errorPage(Number(forced[1]));
    if (allowed(path)) {
      try { return send(await readFile(path.slice(1)), path); }
      catch (err) { if (!missing(err)) throw err; }
    }
    return await errorPage(404);
  } catch (err) {
    createLogger({ route: `${req.method} static` }).error('static.failed', { message: String(err?.message ?? err) });
    try { return await errorPage(500); } catch { return new Response('Server error', { status: 500 }); }
  }
}
