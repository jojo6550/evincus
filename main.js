// Node entry (Render, npm run dev): the site and /api/* from one app. Everything runtime-specific lives here;
// server/ only uses web-standard Request/Response, so its tests run against the same code.
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { statfs } from 'node:fs/promises';
import { dirname } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { openKv } from '@deno/kv';
import { createApp } from './server/index.js';
import { serveStatic } from './server/static.js';
import { kvStore } from './server/lib/kv-store.js';
import { kvLimiter } from './server/lib/limiter.js';
import { createLogger } from './server/lib/log.js';
import { fileAccess } from './server/lib/files.js';
import { clientIp } from './server/lib/client-ip.js';
import { HTTP_OPTIONS, requestBody, sendResponse } from './server/lib/runtime.js';
import { secureResponse } from './server/lib/security.js';

if (process.env.ENVIRONMENT === 'production') {
  const keys = ['ADMIN_TOKEN', 'ORDER_HMAC_KEY', 'NEWSLETTER_KEY'];
  if (keys.some(key => !process.env[key] || process.env[key].length < 32 || /local-dev-only|example/i.test(process.env[key])) || new Set(keys.map(key => process.env[key])).size !== keys.length) {
    throw new Error('Production requires distinct ADMIN_TOKEN, ORDER_HMAC_KEY and NEWSLETTER_KEY secrets of at least 32 characters');
  }
  if (process.env.PAYMENT_MODE !== 'none') throw new Error('This release requires PAYMENT_MODE=none');
}

// KV_PATH puts KV in a SQLite file on Render's persistent disk. Unset (dev), a local file kept across --watch restarts.
const kv = await openKv(process.env.KV_PATH ?? '.kv.sqlite3');
const env = {
  ...process.env,
  COMMIT_SHA: process.env.COMMIT_SHA ?? process.env.RENDER_GIT_COMMIT ?? 'dev',
  ORDERS: kvStore(kv),
  ORDER_LIMIT: kvLimiter(kv, 'order', { limit: 5, period: 60 }),
  BEACON_LIMIT: kvLimiter(kv, 'beacon', { limit: 10, period: 60 }),
  QUOTE_LIMIT: kvLimiter(kv, 'quote', { limit: 60, period: 60 }),
  ADMIN_LIMIT: kvLimiter(kv, 'admin', { limit: 20, period: 60 }),
  LINK_LIMIT: kvLimiter(kv, 'link', { limit: 30, period: 60 }),
};
const app = createApp();
const log = createLogger({ route: 'background' });
const pendingWork = new Set();
const eventLoop = monitorEventLoopDelay({ resolution: 20 }); eventLoop.enable();
let stopping = false;
let lastCron = Date.now();
let diskHealthy = true;
env.OPERATIONS = () => ({ disk: diskHealthy ? 'ok' : 'low', scheduler: Date.now() - lastCron < 2 * QUARTER ? 'ok' : 'overdue' });

// Background work runs past the response in this long-lived process. Failures are logged, and anything that must
// happen (order confirmations) is also queued in KV for the cron to retry.
function context(ip) {
  const pending = [];
  return {
    ip,
    waitUntil: p => {
      const work = Promise.resolve(p).catch(err => log.error('unhandled', { message: String(err?.message ?? err) }));
      pending.push(work); pendingWork.add(work);
      work.finally(() => pendingWork.delete(work));
    },
    settle: () => Promise.all(pending),
  };
}

// Every 15 minutes on the clock (:00, :15, :30, :45), like the old '*/15 * * * *' cron. A run that is still going
// skips the next tick. Emails carry fixed Resend idempotency keys, so a retried run sends nothing twice.
const QUARTER = 15 * 60_000;
let running = false;
async function jobs() {
  if (running || stopping) return;
  running = true;
  try {
    const ctx = context();
    await app.scheduled({}, env, ctx);
    await ctx.settle();
  } catch (err) {
    log.error('cron.failed', { message: String(err?.message ?? err) });
  } finally {
    lastCron = Date.now();
    running = false;
  }
}
let cronInterval;
const cronStart = setTimeout(() => { jobs(); cronInterval = setInterval(jobs, QUARTER); }, QUARTER - (Date.now() % QUARTER));

// Free Render instances sleep after 15 idle minutes, which also stops the cron. Only the public URL counts as
// traffic, so the service calls itself through Render's proxy. Set only on the free dev service, never on prod.
const keepalive = env.KEEPALIVE_URL ? setInterval(() => fetch(env.KEEPALIVE_URL, { signal: AbortSignal.timeout(10000) }).catch(err => log.error('keepalive.failed', { message: String(err?.message ?? err) })), 10 * 60_000) : null;
async function checkDisk() {
  try {
    const disk = await statfs(dirname(env.KV_PATH ?? '.kv.sqlite3'));
    const free = disk.bavail * disk.bsize;
    diskHealthy = free > Math.max(20 * 1024 * 1024, Math.min(256 * 1024 * 1024, disk.blocks * disk.bsize * 0.15));
    if (!diskHealthy) log.error('operations.disk_low');
  } catch { diskHealthy = false; log.error('operations.disk_check_failed'); }
}
await checkDisk();
const diskTimer = setInterval(checkDisk, 60000);
const files = fileAccess(fileURLToPath(new URL('.', import.meta.url)));

// node:http to web Request/Response, so server/ stays runtime-neutral.
async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost').href;
  if (stopping) return sendResponse(req, res, secureResponse(new Response('Service restarting', { status: 503 }), env));
  const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : requestBody(req);
  const request = new Request(url, { method: req.method, headers: req.headers, body, duplex: 'half' });
  const response = new URL(url).pathname.startsWith('/api/')
    ? await app.fetch(request, env, context(clientIp(req, env)))
    : await serveStatic(request, { env, ...files });
  await sendResponse(req, res, response);
}

// Render sets PORT; npm run dev uses 8000.
const server = createServer(HTTP_OPTIONS, (req, res) => handle(req, res).catch(err => {
  log.error('request.failed', { message: String(err?.message ?? err) });
  if (!res.headersSent) void sendResponse(req, res, secureResponse(new Response('Server error', { status: 500, headers: { 'Cache-Control': 'no-store' } }), env)).catch(() => res.destroy()); else res.destroy();
})).listen(Number(env.PORT ?? 8000), '0.0.0.0', () => log.info('runtime.listening', { port: server.address().port }));

async function shutdown() {
  if (stopping) return;
  stopping = true;
  clearTimeout(cronStart); clearInterval(cronInterval); clearInterval(keepalive); clearInterval(diskTimer);
  const deadline = setTimeout(() => { server.closeAllConnections(); process.exit(1); }, 20000);
  try {
    await new Promise(resolve => server.close(resolve));
    while (pendingWork.size) await Promise.allSettled([...pendingWork]);
    kv.close();
    eventLoop.disable();
    clearTimeout(deadline);
  } catch { process.exitCode = 1; clearTimeout(deadline); }
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
if (process.send) process.on('message', message => {
  if (message === 'shutdown') { process.disconnect(); void shutdown(); }
  if (message === 'metrics') process.send({ type: 'metrics', rssBytes: process.memoryUsage().rss, heapUsedBytes: process.memoryUsage().heapUsed, eventLoopP95Ms: Math.round(eventLoop.percentile(95) / 1e6) });
});
