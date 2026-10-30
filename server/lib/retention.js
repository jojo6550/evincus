import { changeOrder, findOrder } from './orders.js';

export const PERSONAL_FIELDS = ['customer', 'payer', 'notes', 'shipto', 'shipping', 'personal'];
const KEEP_MS = 730 * 86400000; // exactly 730 days, no calendar arithmetic
const PAGE = 100;
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
    if (stop || page.list_complete) return true;
    cursor = page.cursor;
    await env.ORDERS.put(cursorKey, cursor);
    if (Date.now() >= deadline) return false;
  }
}

// Removes customer details from orders placed over 2 years ago; amounts, lines, refunds and events stay. -> orders scrubbed.
export async function scrubOrders(env, now, { deadline = Infinity } = {}) {
  const cutoff = new Date(+now - KEEP_MS).toISOString();
  let n = 0;
  await walkDays(env, SCRUB_CURSOR, deadline, async ({ name, metadata }) => {
    if (!metadata?.placedAt || metadata.placedAt >= cutoff) return true; // days sort by date, so the rest are newer
    const id = idOf(name);
    if ((await findOrder(env, id))?.scrubbedAt) return;
    let did = false; // `change` reruns on a version clash, so count once afterwards
    await changeOrder(env, id, r => {
      did = !r.scrubbedAt;
      if (!did) return r;
      for (const f of PERSONAL_FIELDS) delete r[f];
      return { ...r, scrubbedAt: new Date(+now).toISOString() };
    });
    if (did) n++;
  });
  return n;
}

// One-time: rewrites existing orders and their day entries without a TTL. -> true once every key is done.
export async function dropOrderTtls(env, { deadline = Infinity } = {}) {
  if (await env.ORDERS.get(TTL_DONE)) return true;
  const done = await walkDays(env, TTL_CURSOR, deadline, async ({ name }) => {
    try { await changeOrder(env, idOf(name), r => r); } catch (e) { if (e.code !== 'unknown-order') throw e; }
  });
  if (done) await env.ORDERS.put(TTL_DONE, '1');
  return done;
}

// Scheduled entry: each job swallows its own failure so neither blocks the other jobs. -> true when both finished in time.
export async function runRetention(env, c) {
  let ok = true;
  const run = async fn => { try { await fn(); } catch (err) { ok = false; c.log.error('retention.failed', { message: String(err?.message ?? err) }); } };
  await run(async () => { ok = (await dropOrderTtls(env, { deadline: c.deadline })) && ok; });
  await run(() => scrubOrders(env, c.now, { deadline: c.deadline }));
  return ok && Date.now() < c.deadline;
}
