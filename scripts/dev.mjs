// Zero-dependency static dev server. Mirrors GitHub Pages: site lives at /evincus/,
// unknown paths get 404.html with a real 404 status.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
export const BASE = '/evincus';
export const ERROR_CODES = [403, 404, 500, 502, 503, 504];

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};

async function send(res, file, status = 200) {
  const body = await readFile(file);
  res.writeHead(status, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  res.end(body);
}

async function resolveFile(path) {
  const full = normalize(join(ROOT, path));
  if (full !== ROOT && !full.startsWith(ROOT + sep)) return null;
  if (full.split(sep).includes('node_modules') || full.split(sep).includes('.git')) return null;
  try {
    const s = await stat(full);
    if (s.isDirectory()) return resolveFile(join(path, 'index.html'));
    return full;
  } catch { return null; }
}

export function startServer(port = Number(5000)) {
  const server = createServer(async (req, res) => {
    try {
      let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (path === '/') { res.writeHead(302, { Location: BASE + '/' }); return res.end(); }
      if (path === BASE) { res.writeHead(302, { Location: BASE + '/' }); return res.end(); }
      if (path.startsWith(BASE + '/')) path = path.slice(BASE.length);

      // /__error/<code> forces an error page with that status.
      const forced = path.match(/^\/__error\/(\d{3})$/);
      if (forced && ERROR_CODES.includes(Number(forced[1]))) {
        return await send(res, join(ROOT, `${forced[1]}.html`), Number(forced[1]));
      }

      const file = await resolveFile(path);
      if (file) return await send(res, file);
      await send(res, join(ROOT, '404.html'), 404);
    } catch (err) {
      console.error(err);
      await send(res, join(ROOT, '500.html'), 500).catch(() => res.end());
    }
  });
  return new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(port, () => ok({ server, port }));
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { port } = await startServer().catch((e) => {
    console.error(e.code === 'EADDRINUSE' ? 'Port in use. Try: PORT=8081 npm run dev' : e);
    process.exit(1);
  });
  console.log(`Evincus dev: http://localhost:${port}${BASE}/`);
}
