import { json } from '../lib/http.js';
import { getRates } from '../lib/fx.js';

// GET /api/currencies → { base: 'USD', updatedAt, rates }. Estimates for display; checkout always charges USD.
export async function currenciesRoute(req, c) {
  return json(await getRates(c), 200, { 'Cache-Control': 'public, max-age=3600' });
}
