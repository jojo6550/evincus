import { changeOrder, findOrder } from './orders.js';

export const PERSONAL_FIELDS = ['customer', 'payer', 'notes', 'shipto', 'shipping', 'personal', 'pii'];
const KEEP_MS = 730 * 86400000; // exactly 730 days, no calendar arithmetic
const PAGE = 100;
const quiet = { error() {} };
const SCRUB_CURSOR = 'retention:scrub-cursor', TTL_CURSOR = 'retention:ttl-cursor', TTL_DONE = 'retention:ttl-done';
const idOf = name => name.slice(name.indexOf(':', 4) + 1); // day:<date>:<id>

// Pages `day:` keys from the cursor stored at `cursorKey`, calling `each(key)` on each. The page is the unit of progress:
// a spent deadline stops after the page and the saved cursor resumes the next run. `each` returns true to end the walk
// after its page. -> true when the walk reached its end, false when the deadline cut it short.
async function walkDays(env, cursorKey, deadline, each) {
  let cursor = (await env.ORDERS.get(cursorKey)) ?? undefined;
  for (;;) {
    const page = await env.ORDERS.list({ prefix: 'day:', cursor, limit: PAGE });
    let stop = false;
    for (const key of page.keys) stop = (await each(key)) || stop;
    if (stop || page.list_complete) { await env.ORDERS.delete(cursorKey); return true; } // next day starts from the oldest again
    cursor = page.cursor;
    await env.ORDERS.put(cursorKey, cursor);
    if (Date.now() >= deadline) return false;
  }
}

// Runs one order's step; an orphan day: key is skipped silently, any other failure is logged and the walk goes on.
async function perOrder(log, id, step) {
  try { return await step(); } catch (err) {
    if (err.code !== 'unknown-order') log.error('retention.order_failed', { orderId: id, message: String(err?.message ?? err) });
  }
}

// Removes customer details from orders placed over 2 years ago; amounts, lines, refunds and events stay. -> orders scrubbed.
export async function scrubOrders(env, now, { deadline = Infinity, log = quiet } = {}) {
  const cutoff = new Date(+now - KEEP_MS).toISOString();
  let n = 0;
  // Keys sort by Jamaica day then id, not by time, so a newer order ends the walk only after its page; boundary-day stragglers wait for the next run.
  await walkDays(env, SCRUB_CURSOR, deadline, async ({ name, metadata }) => {
    const id = idOf(name);
    if (metadata?.scrubbed) return false;
    if (metadata?.placedAt >= cutoff) return true;
    return perOrder(log, id, async () => {
      const order = await findOrder(env, id);
      if (!order) return false;
      const placedAt = metadata?.placedAt ?? order.placedAt;
      if (!placedAt) return false;
      if (placedAt >= cutoff) return true;
      if (order.scrubbedAt) return false;
      let did = false; // `change` reruns on a version clash, so count once afterwards
      await changeOrder(env, id, r => {
        did = !r.scrubbedAt;
        if (!did) return r;
        for (const f of PERSONAL_FIELDS) delete r[f];
        return { ...r, scrubbedAt: new Date(+now).toISOString() };
      });
      if (did) n++;
      return false;
    });
  });
  return n;
}

// One-time: rewrites existing orders and their day entries without a TTL. -> true once every key is done.
export async function dropOrderTtls(env, { deadline = Infinity, log = quiet } = {}) {
  if (await env.ORDERS.get(TTL_DONE)) return true;
  const done = await walkDays(env, TTL_CURSOR, deadline, async ({ name }) => {
    await perOrder(log, idOf(name), () => changeOrder(env, idOf(name), r => r));
  });
  if (done) await env.ORDERS.put(TTL_DONE, '1');
  return done;
}

// Scheduled entry: each job swallows its own failure so neither blocks the other. -> { done, failed }: done when both
// walks reached their end in time, failed when a whole job threw (the caller allows a limited number of retries a day).
export async function runRetention(env, c) {
  let failed = false, done = true;
  const run = async fn => {
    try { done = (await fn()) !== false && done; } catch (err) { failed = true; c.log.error('retention.failed', { message: String(err?.message ?? err) }); }
  };
  await run(() => dropOrderTtls(env, { deadline: c.deadline, log: c.log }));
  await run(() => scrubOrders(env, c.now, { deadline: c.deadline, log: c.log }));
  return { done: done && !failed && Date.now() < c.deadline, failed };
}
