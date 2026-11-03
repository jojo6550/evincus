import { json } from '../lib/http.js';
import { liveCatalog } from '../lib/catalog.js';

// Calls no outside service, so uptime monitors can poll it freely. A catalog that can't load counts as a KV error.
export async function health(req, c) {
  let kv = 'ok', data = c.data;
  try {
    await c.env.ORDERS.get('health');
    data ??= await liveCatalog(c.env);
  } catch { kv = 'error'; }
  const catalog = { eras: data?.eras.length ?? 0, products: data?.products.length ?? 0 };
  const operations = c.env.OPERATIONS?.();
  const ok = catalog.eras > 0 && catalog.products > 0 && kv === 'ok' && (!operations || Object.values(operations).every(v => v === 'ok'));
  return json({ ok, catalog, kv, ...(operations ? { operations } : {}), commit: c.env.COMMIT_SHA ?? 'dev' }, ok ? 200 : 503, { 'Cache-Control': 'no-store' });
}
