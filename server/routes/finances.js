import { json, HttpError } from '../lib/http.js';
import { requireStaff } from '../lib/accounts.js';
import { jamaicaDay } from '../lib/orders.js';
import { finances, financesCsv } from '../lib/finances.js';

const isDay = d => /^\d{4}-\d{2}-\d{2}$/.test(d ?? '') && new Date(Date.parse(`${d}T00:00:00Z`) || 0).toISOString().startsWith(d);

// ?from=&to= Jamaica days, at most a year; none: this month so far.
function range(req, c) {
  const p = new URL(req.url).searchParams;
  const today = jamaicaDay(+c.now);
  const from = p.get('from') || `${today.slice(0, 8)}01`, to = p.get('to') || today;
  const span = (Date.parse(to) - Date.parse(from)) / 86400000;
  if (!isDay(from) || !isDay(to) || !(span >= 0 && span < 366)) throw new HttpError('invalid-query', 400);
  return { from, to };
}

// GET /api/inventory/finances (owners).
export async function financesRoute(req, c) {
  await requireStaff(req, c, { role: 'owner' });
  return json(await finances(c.env, range(req, c)), 200, { 'Cache-Control': 'no-store' });
}

// GET /api/inventory/finances.csv (owners): paid orders and refunds, no customer details.
export async function financesCsvRoute(req, c) {
  await requireStaff(req, c, { role: 'owner' });
  const r = range(req, c);
  return new Response(await financesCsv(c.env, r), { headers: {
    'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="evincus-finances-${r.from}-to-${r.to}.csv"`, 'Cache-Control': 'no-store',
  } });
}
