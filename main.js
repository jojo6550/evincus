// Deno Deploy entry: the site and /api/* from one app. Everything Deno-specific lives here;
// server/ stays runtime-neutral so its tests run under Node.
import { createApp } from './server/index.js';
import { serveStatic } from './server/static.js';
import { kvStore } from './server/lib/kv-store.js';
import { kvLimiter } from './server/lib/limiter.js';
import { createLogger } from './server/lib/log.js';

const kv = await Deno.openKv();
const env = {
  ...Deno.env.toObject(),
  COMMIT_SHA: Deno.env.get('COMMIT_SHA') ?? Deno.env.get('DENO_DEPLOYMENT_ID') ?? 'dev',
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

// Registered at top level so Deploy discovers it. Awaiting settle() keeps a run alive until its work is done,
// and Deploy skips a run while the previous one is still going.
Deno.cron('jobs', '*/15 * * * *', async () => {
  const ctx = context();
  await app.scheduled({}, env, ctx);
  await ctx.settle();
});

const readFile = path => Deno.readFile(new URL(path, import.meta.url));

Deno.serve((req, info) => new URL(req.url).pathname.startsWith('/api/')
  ? app.fetch(req, env, context(info.remoteAddr.hostname))
  : serveStatic(req, { env, readFile }));
