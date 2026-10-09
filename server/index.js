import { CATALOG } from './lib/catalog.js';
import { applySales } from '../data/catalog.js';
import { loadSales } from './lib/sales.js';
import { createLogger } from './lib/log.js';
import { HttpError, corsHeaders, fail } from './lib/http.js';
import { alert } from './lib/alerts.js';
import { retryEmails } from './lib/delivery.js';
import { health } from './routes/health.js';
import { listEras, getEra } from './routes/eras.js';
import { getProduct } from './routes/products.js';
import { quoteRoute } from './routes/quote.js';
import { createOrderRoute } from './routes/orders.js';
import { captureRoute } from './routes/capture.js';
import { beacon } from './routes/beacon.js';
import { checkoutOptions } from './routes/checkout.js';
import { dailyOrderSummary } from './lib/digest.js';
import { newsletter } from './lib/newsletter.js';
import { subscribeRoute, confirmRoute, unsubscribeRoute } from './routes/newsletter.js';
import { getSalesRoute, putSalesRoute } from './routes/admin.js';

// The fourth field marks routes that read prices: they get the catalog with running sales applied.
const ROUTES = [
  ['GET', /^\/api\/checkout\/options$/, checkoutOptions],
  ['GET', /^\/api\/health$/, health],
  ['GET', /^\/api\/eras$/, listEras, true],
  ['GET', /^\/api\/eras\/([a-z0-9-]+)$/, getEra, true],
  ['GET', /^\/api\/products\/([a-z0-9-]+)$/, getProduct, true],
  ['POST', /^\/api\/bag\/quote$/, quoteRoute, true],
  ['POST', /^\/api\/orders$/, createOrderRoute, true],
  ['POST', /^\/api\/orders\/capture$/, captureRoute, true],
  ['POST', /^\/api\/beacon$/, beacon],
  ['POST', /^\/api\/newsletter\/subscribe$/, subscribeRoute],
  ['POST', /^\/api\/newsletter\/confirm$/, confirmRoute],
  ['POST', /^\/api\/newsletter\/unsubscribe$/, unsubscribeRoute],
  ['GET', /^\/api\/admin\/sales$/, getSalesRoute],
  ['PUT', /^\/api\/admin\/sales$/, putSalesRoute],
];

export function createApp({ data = CATALOG, clock = () => Date.now() } = {}) {
  return {
    async fetch(req, env, ctx) {
      const started = Date.now();
      const url = new URL(req.url);
      const reqId = crypto.randomUUID();
      const log = createLogger({ reqId, route: `${req.method} ${url.pathname}` });
      const c = { env, data, now: new Date(clock()), reqId, log, ip: ctx.ip ?? 'unknown', waitUntil: p => ctx.waitUntil(p), params: [] };

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
            if (hit[3]) {
              c.base = data;
              c.sales = await loadSales(env, log);
              c.data = applySales(data, c.sales, c.now);
            }
            res = url.pathname === '/api/orders/capture' && env.PAYMENT_MODE !== 'paypal'
              ? fail(c, 'payments-disabled', 403) : await hit[2](req, c);
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
    async scheduled(event, env, ctx) {
      const log = createLogger({ route: 'cron' });
      const now = clock();
      const c = { env, data, now: new Date(now), reqId: `cron-${now}`, log, waitUntil: p => ctx.waitUntil(p), params: [] };
      const logFailure = err => log.error('unhandled', { message: String(err?.message ?? err) });
      ctx.waitUntil((async () => {
        await retryEmails(c);
        if (env.PAYMENT_MODE !== 'paypal') await dailyOrderSummary(c);
      })().catch(logFailure));
      ctx.waitUntil(newsletter(c).catch(logFailure));
    },
  };
}

export default createApp();
