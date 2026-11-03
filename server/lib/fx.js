// USD exchange rates for showing estimated prices. Display only: every charge is in USD.
// Source: ExchangeRate-API's open endpoint (no key, daily updates, attribution required on the page).
export const FX_KEY = 'fx:latest';
export const FX_MAX_AGE_MS = 43200000; // 12 hours
const SOURCE = 'https://open.er-api.com/v6/latest/USD';
const USD_ONLY = { base: 'USD', updatedAt: null, rates: { USD: 1 } };

const view = saved => ({ base: 'USD', updatedAt: saved.updatedAt, rates: saved.rates });

// Fetches and caches the rates. -> true when new rates were saved. Last write wins: concurrent refreshes write the
// same shape, so neither can corrupt the other.
export async function refreshRates(c) {
  try {
    const res = await fetch(SOURCE, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
    const data = res.ok ? await res.json() : null;
    if (data?.result !== 'success' || data.rates?.USD !== 1) throw new Error('unexpected exchange-rate response');
    const rates = Object.fromEntries(Object.entries(data.rates).filter(([code, r]) => /^[A-Z]{3}$/.test(code) && typeof r === 'number' && Number.isFinite(r) && r > 0));
    const updatedAt = Number.isFinite(data.time_last_update_unix) ? new Date(data.time_last_update_unix * 1000).toISOString() : c.now.toISOString();
    await c.env.ORDERS.put(FX_KEY, JSON.stringify({ fetchedAt: c.now.toISOString(), updatedAt, rates }));
    return true;
  } catch (err) {
    c.log.warn('fx.failed', { message: String(err?.message ?? err) });
    return false;
  }
}

// Cached rates; stale ones are served at once and refreshed in the background. Never fetched and the source down: USD only.
export async function getRates(c) {
  const saved = await c.env.ORDERS.get(FX_KEY, 'json');
  if (!saved) {
    if (!(await refreshRates(c))) return USD_ONLY;
    return view(await c.env.ORDERS.get(FX_KEY, 'json'));
  }
  if (+c.now - Date.parse(saved.fetchedAt) >= FX_MAX_AGE_MS) c.waitUntil(refreshRates(c));
  return view(saved);
}
