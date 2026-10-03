import { CATALOG } from './lib/catalog.js';
import { createLogger } from './lib/log.js';
import { HttpError, corsHeaders, fail } from './lib/http.js';
import { alert } from './lib/alerts.js';
import { health } from './routes/health.js';
import { listEras, getEra } from './routes/eras.js';
import { getProduct } from './routes/products.js';
import { quoteRoute } from './routes/quote.js';
import { createOrderRoute } from './routes/orders.js';
import { captureRoute } from './routes/capture.js';

const ROUTES = [
  ['GET', /^\/api\/health$/, health],
  ['GET', /^\/api\/eras$/, listEras],
  ['GET', /^\/api\/eras\/([a-z0-9-]+)$/, getEra],
  ['GET', /^\/api\/products\/([a-z0-9-]+)$/, getProduct],
  ['POST', /^\/api\/bag\/quote$/, quoteRoute],
  ['POST', /^\/api\/orders$/, createOrderRoute],
  ['POST', /^\/api\/orders\/capture$/, captureRoute],
];

export function createApp({ data = CATALOG, clock = () => Date.now() } = {}) {
  return {
    async fetch(req, env, ctx) {
      const started = Date.now();
      const url = new URL(req.url);
      const reqId = req.headers.get('cf-ray') ?? crypto.randomUUID();
      const log = createLogger({ reqId, route: `${req.method} ${url.pathname}` });
      const c = { env, data, now: new Date(clock()), reqId, log, waitUntil: p => ctx.waitUntil(p), params: [] };

      let res;
      try {
        if (req.method === 'OPTIONS') {
          res = new Response(null, { status: 204 });
        } else {
          const matches = ROUTES.filter(([, re]) => re.test(url.pathname));
          const hit = matches.find(([method]) => method === req.method);
          if (!matches.length) res = fail(c, 'not-found', 404);
          else if (!hit) res = fail(c, 'method-not-allowed', 405);
          else {
            c.params = url.pathname.match(hit[1]).slice(1);
            res = await hit[2](req, c);
          }
        }
      } catch (err) {
        if (err instanceof HttpError) res = fail(c, err.code, err.status);
        else {
          log.error('unhandled', { message: String(err?.message ?? err), stack: String(err?.stack ?? '') });
          c.waitUntil(alert(c, 'unhandled', { subject: 'Unhandled error', rows: [['Route', `${req.method} ${url.pathname}`], ['Message', String(err?.message ?? err)]] }));
          res = fail(c, 'server-error', 500);
        }
      }

      res = new Response(res.body, res);
      for (const [k, v] of Object.entries(corsHeaders(req.headers.get('Origin'), env))) res.headers.set(k, v);
      res.headers.set('x-request-id', reqId);
      const level = res.status >= 500 ? 'error' : res.status >= 400 ? 'warn' : 'info';
      log[level]('request', { status: res.status, ms: Date.now() - started });
      return res;
    },
  };
}

export default createApp();
