// Node entry (Render, npm run dev): the site and /api/* from one app. Everything runtime-specific lives here;
// server/ only uses web-standard Request/Response, so its tests run against the same code.
import { createServer } from 'node:http';
import { readFile as fsReadFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { openKv } from '@deno/kv';
import { createApp } from './server/index.js';
import { serveStatic } from './server/static.js';
import { kvStore } from './server/lib/kv-store.js';
import { kvLimiter } from './server/lib/limiter.js';
import { createLogger } from './server/lib/log.js';

// KV_PATH puts KV in a SQLite file on Render's persistent disk. Unset (dev), a local file kept across --watch restarts.
const kv = await openKv(process.env.KV_PATH ?? '.kv.sqlite3');
const env = {
  ...process.env,
  COMMIT_SHA: process.env.COMMIT_SHA ?? process.env.RENDER_GIT_COMMIT ?? 'dev',
  ORDERS: kvStore(kv),
  ORDER_LIMIT: kvLimiter(kv, 'order', { limit: 5, period: 60 }),
  BEACON_LIMIT: kvLimiter(kv, 'beacon', { limit: 10, period: 60 }),
};
const app = createApp();
const log = createLogger({ route: 'background' });

// Background work runs past the response in this long-lived process. Failures are logged, and anything that must
// happen (order confirmations) is also queued in KV for the cron to retry.
function context(ip) {
  const pending = [];
  return {
    ip,
    waitUntil: p => { pending.push(Promise.resolve(p).catch(err => log.error('unhandled', { message: String(err?.message ?? err) }))); },
    settle: () => Promise.all(pending),
  };
}

// Every 15 minutes on the clock (:00, :15, :30, :45), like the old '*/15 * * * *' cron. A run that is still going
// skips the next tick. Emails carry fixed Resend idempotency keys, so a retried run sends nothing twice.
const QUARTER = 15 * 60_000;
let running = false;
async function jobs() {
  if (running) return;
  running = true;
  try {
    const ctx = context();
    await app.scheduled({}, env, ctx);
    await ctx.settle();
  } catch (err) {
    log.error('cron.failed', { message: String(err?.message ?? err) });
  } finally {
    running = false;
  }
}
setTimeout(() => { jobs(); setInterval(jobs, QUARTER); }, QUARTER - (Date.now() % QUARTER));

const readFile = path => fsReadFile(new URL(path, import.meta.url));

// On Render the socket address is the proxy, which would put every shopper in one rate-limit bucket.
// shortcut: trusts Render's word that it sets the first X-Forwarded-For entry; if spoofable, read Cloudflare's CF-Connecting-IP.
const clientIp = req =>
  (env.RENDER && req.headers['x-forwarded-for']?.split(',')[0].trim()) || req.socket.remoteAddress;

// node:http to web Request/Response, so server/ stays runtime-neutral.
async function handle(req, res) {
  const url = `http://${req.headers.host ?? 'localhost'}${req.url}`;
  const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : Readable.toWeb(req);
  const request = new Request(url, { method: req.method, headers: req.headers, body, duplex: 'half' });
  const response = new URL(url).pathname.startsWith('/api/')
    ? await app.fetch(request, env, context(clientIp(req)))
    : await serveStatic(request, { env, readFile });
  res.statusCode = response.status;
  res.setHeaders(response.headers);
  if (!response.body || req.method === 'HEAD') return res.end();
  Readable.fromWeb(response.body).on('error', () => res.destroy()).pipe(res);
}

// Render sets PORT; npm run dev uses 8000.
createServer((req, res) => handle(req, res).catch(err => {
  log.error('request.failed', { message: String(err?.message ?? err) });
  if (!res.headersSent) { res.statusCode = 500; res.end('Server error'); } else res.destroy();
})).listen(Number(env.PORT ?? 8000));
