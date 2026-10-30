import { liveCatalog } from './lib/catalog.js';
import { applySales, applyStock } from '../data/catalog.js';
import { loadSales } from './lib/sales.js';
import { loadStock } from './lib/stock.js';
import { createLogger } from './lib/log.js';
import { logSink } from './lib/log-store.js';
import { HttpError, corsHeaders, fail, enforceLimit, siteStatus } from './lib/http.js';
import { secureResponse } from './lib/security.js';
import { cleanMedia } from './lib/media.js';
import { alert } from './lib/alerts.js';
import { runRetention } from './lib/retention.js';
import { retryEmails } from './lib/delivery.js';
import { health } from './routes/health.js';
import { listEras, getEra, getCatalog } from './routes/eras.js';
import { getProduct } from './routes/products.js';
import { quoteRoute } from './routes/quote.js';
import { beacon } from './routes/beacon.js';
import { checkoutOptions, placeOrderRoute } from './routes/checkout.js';
import { dailyOrderSummary } from './lib/digest.js';
import { newsletter } from './lib/newsletter.js';
import { subscribeRoute, confirmRoute, unsubscribeRoute } from './routes/newsletter.js';
import { getSalesRoute, putSalesRoute, listAccountsRoute, putAccountRoute, deleteAccountRoute, listErasAdminRoute, newEraRoute, uploadMediaAdminRoute, attachPhotosRoute } from './routes/admin.js';
import { loginRoute, logoutRoute, meRoute, adjustStockRoute, listProductsRoute, getProductRoute, productHistoryRoute, saveProductRoute, listErasRoute, saveEraRoute, eraOrderRoute, uploadMediaRoute, orderActionRoute, listOrdersRoute, getOrderRoute, statsRoute, logsRoute, healthDetailRoute } from './routes/inventory.js';

// The fourth field marks routes that read the catalog: only they load it, with running sales and stock applied.
// Health loads its own, so a KV failure still answers 503 with kv: 'error'.
const ROUTES = [
  ['GET', /^\/api\/checkout\/options$/, checkoutOptions],
  ['GET', /^\/api\/health$/, health],
  ['GET', /^\/api\/catalog$/, getCatalog, true],
  ['GET', /^\/api\/eras$/, listEras, true],
  ['GET', /^\/api\/eras\/([a-z0-9-]+)$/, getEra, true],
  ['GET', /^\/api\/products\/([a-z0-9-]+)$/, getProduct, true],
  ['POST', /^\/api\/bag\/quote$/, quoteRoute, true],
  ['POST', /^\/api\/orders$/, placeOrderRoute, true],
  ['POST', /^\/api\/beacon$/, beacon],
  ['POST', /^\/api\/newsletter\/subscribe$/, subscribeRoute],
  ['POST', /^\/api\/newsletter\/confirm$/, confirmRoute],
  ['POST', /^\/api\/newsletter\/unsubscribe$/, unsubscribeRoute],
  ['GET', /^\/api\/admin\/sales$/, getSalesRoute],
  ['PUT', /^\/api\/admin\/sales$/, putSalesRoute],
  ['GET', /^\/api\/admin\/accounts$/, listAccountsRoute],
  ['PUT', /^\/api\/admin\/accounts$/, putAccountRoute],
  ['DELETE', /^\/api\/admin\/accounts\/([^/]+)$/, deleteAccountRoute],
  ['GET', /^\/api\/admin\/eras$/, listErasAdminRoute],
  ['POST', /^\/api\/admin\/eras$/, newEraRoute],
  ['PUT', /^\/api\/admin\/media$/, uploadMediaAdminRoute],
  ['POST', /^\/api\/admin\/photos$/, attachPhotosRoute],
  ['PUT', /^\/api\/inventory\/media$/, uploadMediaRoute],
  ['POST', /^\/api\/inventory\/login$/, loginRoute],
  ['POST', /^\/api\/inventory\/logout$/, logoutRoute],
  ['GET', /^\/api\/inventory\/me$/, meRoute],
  ['POST', /^\/api\/inventory\/stock$/, adjustStockRoute, true],
  ['GET', /^\/api\/inventory\/products$/, listProductsRoute, true],
  ['GET', /^\/api\/inventory\/products\/([a-z0-9-]+)$/, getProductRoute],
  ['PUT', /^\/api\/inventory\/products\/([a-z0-9-]+)$/, saveProductRoute],
  ['GET', /^\/api\/inventory\/products\/([a-z0-9-]+)\/history$/, productHistoryRoute],
  ['GET', /^\/api\/inventory\/eras$/, listErasRoute],
  ['PUT', /^\/api\/inventory\/eras\/([a-z0-9-]+)$/, saveEraRoute],
  ['PUT', /^\/api\/inventory\/era-order$/, eraOrderRoute],
  ['GET', /^\/api\/inventory\/orders$/, listOrdersRoute],
  ['GET', /^\/api\/inventory\/stats$/, statsRoute, true],
  ['GET', /^\/api\/inventory\/orders\/([A-Za-z0-9-]+)$/, getOrderRoute, true],
  ['POST', /^\/api\/inventory\/orders\/([A-Za-z0-9-]+)\/actions$/, orderActionRoute],
  ['GET', /^\/api\/inventory\/logs$/, logsRoute],
  ['GET', /^\/api\/inventory\/health$/, healthDetailRoute],
];

// Routes with path parameters log their pattern, never the raw path (it can hold a staff email, even %40-encoded).
function routeName(req, pathname) {
  const hit = ROUTES.find(([method, re]) => method === req.method && re.test(pathname));
  if (hit) return `${req.method} ${hit[1].source.replaceAll('\\/', '/').replace(/\(.*?\)/g, ':param').replace(/^\^|\$$/g, '')}`;
  try { return `${req.method} ${decodeURIComponent(pathname)}`; } catch { return `${req.method} ${pathname}`; }
}

// `data` replaces the KV catalog (tests); stock still comes from env.ORDERS.
export function createApp({ data, clock = () => Date.now() } = {}) {
  return {
    async fetch(req, env, ctx) {
      const started = Date.now();
      const url = new URL(req.url);
      const reqId = crypto.randomUUID();
      const route = routeName(req, url.pathname);
      const log = createLogger({ reqId, route }, { sink: logSink(env, p => ctx.waitUntil(p)) });
      const c = { env, data, now: new Date(clock()), reqId, log, ip: ctx.ip ?? 'unknown', waitUntil: p => ctx.waitUntil(p), params: [] };

      let res;
      try {
        // No orders while the store is down; health, newsletter.html's confirm/unsubscribe, and the staff APIs (/api/inventory/*, /api/admin/*) keep working.
        const status = siteStatus(req, env);
        if (status !== 'live' && !/^\/api\/(health|newsletter\/(confirm|unsubscribe)|(inventory|admin)\/.*)$/.test(url.pathname)) {
          res = fail(c, status, 503);
        } else if (req.method === 'OPTIONS') {
          res = new Response(null, { status: 204 });
        } else {
          const matches = ROUTES.filter(([, re]) => re.test(url.pathname));
          const hit = matches.find(([method]) => method === req.method);
          if (!matches.length) res = fail(c, 'not-found', 404);
          else if (!hit) res = fail(c, 'method-not-allowed', 405);
          else {
            if (url.pathname.startsWith('/api/admin/')) await enforceLimit(c, env.ADMIN_LIMIT);
            if (url.pathname.startsWith('/api/inventory/')) await enforceLimit(c, env.INVENTORY_LIMIT);
            if (url.pathname === '/api/bag/quote') await enforceLimit(c, env.QUOTE_LIMIT);
            if (url.pathname === '/api/newsletter/confirm' || url.pathname === '/api/newsletter/unsubscribe') await enforceLimit(c, env.LINK_LIMIT);
            c.params = url.pathname.match(hit[1]).slice(1);
            if (hit[3]) {
              const [catalog, sales, stock] = await Promise.all([data === undefined ? liveCatalog(env) : data, loadSales(env, log), loadStock(env)]);
              c.sales = sales;
              c.stock = stock; // on hand and committed per line key, for the inventory list
              c.data = applyStock(applySales(catalog, sales, c.now), stock);
            }
            res = await hit[2](req, c);
          }
        }
      } catch (err) {
        if (err instanceof HttpError) res = fail(c, err.code, err.status, err.extra);
        else {
          log.error('unhandled', { message: String(err?.message ?? err), stack: String(err?.stack ?? '') });
          c.waitUntil(alert(c, 'unhandled', { subject: 'Unhandled error', rows: [['Route', route], ['Message', String(err?.message ?? err)]] }));
          res = fail(c, 'server-error', 500);
        }
      }

      res = secureResponse(res, env);
      if (!res.headers.has('Cache-Control')) res.headers.set('Cache-Control', 'no-store');
      for (const [k, v] of Object.entries(corsHeaders(req.headers.get('Origin'), env))) res.headers.set(k, v);
      res.headers.set('x-request-id', reqId);
      const level = res.status >= 500 ? 'error' : res.status >= 400 ? 'warn' : 'info';
      log[level]('request', { status: res.status, ms: Date.now() - started });
      return res;
    },
    async scheduled(event, env, ctx) {
      const log = createLogger({ route: 'cron' }, { sink: logSink(env, p => ctx.waitUntil(p)) });
      const now = clock();
      const c = { env, data, now: new Date(now), deadline: Date.now() + 45000, reqId: `cron-${now}`, log, waitUntil: p => ctx.waitUntil(p), params: [] };
      const logFailure = err => log.error('unhandled', { message: String(err?.message ?? err) });
      const runs = [];
      const run = p => { const w = p.catch(logFailure); runs.push(w); ctx.waitUntil(w); };
      run((async () => {
        await retryEmails(c);
        await dailyOrderSummary(c);
      })());
      run((async () => {
        // Drop emails list only buyable products, so they need stock too.
        if (data === undefined) c.data = applyStock(await liveCatalog(env), await loadStock(env));
        await newsletter(c);
      })());
      run((async () => {
        const marker = `media-gc:${new Date(now - 5 * 3600000).toISOString().slice(0, 10)}`; // Jamaica day, UTC-5
        if (await env.ORDERS.get(marker)) return;
        await cleanMedia(env, c.now, log);
        await env.ORDERS.put(marker, '1', { expirationTtl: 172800 });
      })());
      run((async () => {
        const marker = `retention:${new Date(now - 5 * 3600000).toISOString().slice(0, 10)}`; // Jamaica day, UTC-5
        if (await env.ORDERS.get(marker)) return;
        const attemptKey = marker.replace('retention:', 'retention:attempt:');
        const attempts = Number((await env.ORDERS.get(attemptKey)) ?? 0);
        if (attempts >= 2) return; // a job that throws gets one retry a day, not one every 15 minutes
        const { done, failed } = await runRetention(env, c);
        if (done) await env.ORDERS.put(marker, '1', { expirationTtl: 172800 });
        else if (failed) await env.ORDERS.put(attemptKey, String(attempts + 1), { expirationTtl: 172800 });
      })());
      // After every job above has settled, so the health panel's "last run" means the run finished.
      ctx.waitUntil(Promise.all(runs).then(() => env.ORDERS.put('cron:lastRun', c.now.toISOString())).catch(logFailure));
    },
  };
}

export default createApp();
