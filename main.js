// Deno entry (Render's Docker image, npm run dev): the site and /api/* from one app. Everything
// Deno-specific lives here; server/ stays runtime-neutral so its tests run under Node.
import { createApp } from './server/index.js';
import { serveStatic } from './server/static.js';
import { kvStore } from './server/lib/kv-store.js';
import { kvLimiter } from './server/lib/limiter.js';
import { createLogger } from './server/lib/log.js';

// KV_PATH puts KV in a SQLite file on Render's persistent disk. Unset, Deno picks its default store.
const kv = await Deno.openKv(Deno.env.get('KV_PATH'));
const env = {
  ...Deno.env.toObject(),
  COMMIT_SHA: Deno.env.get('COMMIT_SHA') ?? Deno.env.get('RENDER_GIT_COMMIT') ?? 'dev',
  ORDERS: kvStore(kv),
  ORDER_LIMIT: kvLimiter(kv, 'order', { limit: 5, period: 60 }),
  BEACON_LIMIT: kvLimiter(kv, 'beacon', { limit: 10, period: 60 }),
};
const app = createApp();
const log = createLogger({ route: 'background' });

// Deno gives background work no lifetime past the response. Failures are logged, and anything that must happen
// (order confirmations) is also queued in KV for the cron to retry.
function context(ip) {
  const pending = [];
  return {
    ip,
    waitUntil: p => { pending.push(Promise.resolve(p).catch(err => log.error('unhandled', { message: String(err?.message ?? err) }))); },
    settle: () => Promise.all(pending),
  };
}

// Registered at top level and runs for the life of the process. Awaiting settle() keeps a run alive until its work
// is done. Emails carry fixed Resend idempotency keys, so a run that overlaps the previous one sends nothing twice.
Deno.cron('jobs', '*/15 * * * *', async () => {
  const ctx = context();
  await app.scheduled({}, env, ctx);
  await ctx.settle();
});

const readFile = path => Deno.readFile(new URL(path, import.meta.url));

// On Render remoteAddr is the proxy, which would put every shopper in one rate-limit bucket.
// shortcut: trusts Render's word that it sets the first X-Forwarded-For entry; if spoofable, read Cloudflare's CF-Connecting-IP.
const clientIp = (req, info) =>
  (env.RENDER && req.headers.get('x-forwarded-for')?.split(',')[0].trim()) || info.remoteAddr.hostname;

// Render sets PORT; npm run dev uses 8000.
Deno.serve({ port: Number(env.PORT ?? 8000) }, (req, info) => new URL(req.url).pathname.startsWith('/api/')
  ? app.fetch(req, env, context(clientIp(req, info)))
  : serveStatic(req, { env, readFile }));
