import { ORDER_TTL, orderKey, retryKey, dayKey } from './orders.js';

export const submissionKey = id => `submission:${id}`;
const ROUNDS = 3;

// One order per checkout token. The submission, the order, its day index and its email retry job land in one
// atomic commit that only succeeds while the submission is unchanged since it was read, so double clicks and network
// retries can't create a second order or a half-saved one. The retry job is written before the order is
// acknowledged, so a confirmation lost to a shutdown is still sent by the cron.
export async function submitOrder(env, id, fingerprint, record) {
  for (let round = 0; round < ROUNDS; round++) {
    const { value, version } = await env.ORDERS.getEntry(submissionKey(id));
    if (value) {
      const saved = JSON.parse(value);
      return saved.fingerprint === fingerprint ? { record: saved.record } : { conflict: true };
    }
    if (!record) return { record: null };
    const ttl = { expirationTtl: ORDER_TTL };
    const saved = await env.ORDERS.commit({
      checks: [{ key: submissionKey(id), version }],
      puts: [
        { key: submissionKey(id), value: JSON.stringify({ fingerprint, record }), opts: ttl },
        { key: orderKey(record.id), value: JSON.stringify(record), opts: ttl },
        { key: dayKey(record), value: '', opts: ttl },
        { key: retryKey(record.id), value: JSON.stringify({ retries: 0, nextAt: Date.parse(record.placedAt) }) },
      ],
    });
    if (saved) return { record };
  }
  throw new Error('Order storage unavailable');
}
