import { ORDER_TTL, orderPuts, retryKey, bumpOrders } from './orders.js';
import { stockKey, checkoutStock } from './stock.js';
import { HttpError } from './http.js';

export const submissionKey = id => `submission:${id}`;
// Every checkout of a product races on its one stock document. A lost round always means another order landed, so
// 10 rounds see 10 shoppers through; a short jittered pause spreads the retries.
const ROUNDS = 10;
const pause = round => new Promise(r => setTimeout(r, (5 + Math.random() * 20) * (1 + round / 4)));

// One order per checkout token. The submission, the order, its day index, its email retry job and its stock
// commitment land in one atomic commit that only succeeds while the submission and every stock document read are
// unchanged, so double clicks and network retries can't create a second order or a half-saved one, and two shoppers
// can't both buy the last unit. The retry job is written before the order is acknowledged, so a confirmation lost to
// a shutdown is still sent by the cron. `products` are the internal ones, read for `continueSelling`.
export async function submitOrder(env, id, fingerprint, record, { products = [] } = {}) {
  const ids = [...new Set(record?.lines.map(l => l.id))];
  for (let round = 0; round < ROUNDS; round++) {
    if (round) await pause(round);
    // Stock before the submission, so a shortage seen here can't be this token's own order landing in between.
    // Every round reads again: a lost round's versions would only fail again.
    const entries = new Map(await Promise.all(ids.map(async pid => [pid, await env.ORDERS.getEntry(stockKey(pid))])));
    const { value, version } = await env.ORDERS.getEntry(submissionKey(id));
    if (value) {
      const saved = JSON.parse(value);
      return saved.fingerprint === fingerprint ? { record: saved.record } : { conflict: true };
    }
    if (!record) return { record: null };
    const stock = checkoutStock(entries, record.lines, products, { orderId: record.id, now: new Date(record.placedAt) });
    if (stock.short) return { short: stock.short };
    const ttl = { expirationTtl: ORDER_TTL };
    const saved = await env.ORDERS.commit({
      checks: [{ key: submissionKey(id), version }, ...stock.checks],
      puts: [
        { key: submissionKey(id), value: JSON.stringify({ fingerprint, record }), opts: ttl },
        ...orderPuts(record),
        { key: retryKey(record.id), value: JSON.stringify({ retries: 0, nextAt: Date.parse(record.placedAt) }) },
        ...stock.puts,
      ],
    });
    if (saved) { bumpOrders(); return { record }; }
  }
  // Handled, not unhandled: the shopper retries with the same token, and the owner gets no alert.
  throw new HttpError('busy', 503);
}
