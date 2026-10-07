import { sendEmail } from './email.js';
import { findOrder, recordRows, ORDER_TTL } from './orders.js';
import { esc, layout, table, money } from '../emails/html.js';

async function keys(env, prefix) {
  const result = [];
  let cursor;
  do {
    const page = await env.ORDERS.list({ prefix, cursor });
    result.push(...page.keys.map(k => k.name));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return result;
}

// Called every 15 minutes: prepare yesterday's summary after 08:00 Jamaica time,
// then retry any unsent parts. Persist exact bodies so retries have stable content.
export async function dailyOrderSummary(c) {
  const local = new Date(+c.now - 5 * 3600000);
  if (local.getUTCHours() >= 8) {
    const yesterday = new Date(+local - 86400000).toISOString().slice(0, 10);
    const lastPrepared = await c.env.ORDERS.get('digest-last-prepared');
    let day = lastPrepared ? new Date(Date.parse(lastPrepared) + 86400000).toISOString().slice(0, 10) : yesterday;
    let preparedThrough = lastPrepared;
    // Catch up after missed cron runs. Bound each run, then resume from the cursor.
    for (let prepared = 0; day <= yesterday && prepared < 7; prepared++) {
      const key = `digest-pending:${day}`;
      if (!await c.env.ORDERS.get(`digest-sent:${day}`) && !await c.env.ORDERS.get(key)) {
        const records = [];
        for (const name of await keys(c.env, `day:${day}:`)) {
          const record = await findOrder(c.env, name.slice(`day:${day}:`.length));
          // Missing indexed records indicate a storage outage; never send a partial summary.
          if (!record) throw new Error('Daily summary order unavailable');
          records.push(record);
        }
        const parts = [];
        const chunkSize = 20;
        for (let offset = 0; offset < Math.max(records.length, 1); offset += chunkSize) {
          const chunk = records.slice(offset, offset + chunkSize);
          parts.push({ sent: false, subject: `Evincus orders — ${day} (${records.length} orders) — part ${parts.length + 1}`,
            html: layout(`Orders for ${day}`, `<p>${records.length} orders. Order value: ${money(records.reduce((n, r) => n + r.totalCents, 0))} USD. This is order value, not collected revenue.</p>${chunk.length ? chunk.map(r => `<h2>${esc(r.id)}</h2>${table(recordRows(r))}`).join('') : '<p>No orders today.</p>'}`) });
        }
        await c.env.ORDERS.put(key, JSON.stringify({ day, parts }), { expirationTtl: ORDER_TTL });
      }
      preparedThrough = day;
      day = new Date(Date.parse(day) + 86400000).toISOString().slice(0, 10);
    }
    if (preparedThrough !== lastPrepared) await c.env.ORDERS.put('digest-last-prepared', preparedThrough);
  }
  for (const key of await keys(c.env, 'digest-pending:')) {
    const job = await c.env.ORDERS.get(key, 'json');
    if (!job?.parts) continue;
    for (let i = 0; i < job.parts.length; i++) {
      const part = job.parts[i];
      if (part.sent) continue;
      try {
        await sendEmail(c.env, { to: c.env.OWNER_EMAIL, subject: part.subject, html: part.html, idempotencyKey: `daily-orders-${job.day}-${i}` });
        part.sent = true;
        await c.env.ORDERS.put(key, JSON.stringify(job), { expirationTtl: ORDER_TTL });
        c.log.info('digest.sent', { day: job.day, part: i + 1 });
      } catch (err) { c.log.error('digest.failed', { day: job.day, message: String(err.message) }); }
    }
    if (job.parts.every(p => p.sent)) {
      await c.env.ORDERS.put(`digest-sent:${job.day}`, 'sent', { expirationTtl: ORDER_TTL });
      await c.env.ORDERS.delete(key);
    }
  }
}
