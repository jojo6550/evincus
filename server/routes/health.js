import { json } from '../lib/http.js';

// Never calls PayPal, so uptime monitors can poll it freely.
export async function health(req, c) {
  const catalog = { eras: c.data.eras.length, products: c.data.products.length };
  let kv = 'ok';
  try { await c.env.ORDERS.get('health'); } catch { kv = 'error'; }
  const ok = catalog.eras > 0 && catalog.products > 0 && kv === 'ok';
  return json({ ok, catalog, kv, commit: c.env.COMMIT_SHA ?? 'dev' }, ok ? 200 : 503, { 'Cache-Control': 'no-store' });
}
