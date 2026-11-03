import { sendEmail } from './email.js';
import { findOrder, recordRows, revealOrder, ORDER_TTL } from './orders.js';
import { esc, layout, table, money } from '../emails/html.js';
import { seal, unseal } from './crypto.js';

const sum = (records, f) => records.reduce((n, r) => n + (r[f] ?? 0), 0);

async function keys(env, prefix, deadline) {
  const result = [];
  let cursor;
  do {
    if (deadline && Date.now() >= deadline - 1000) throw new Error('Daily summary preparation time budget reached; resume next run');
    const page = await env.ORDERS.list({ prefix, cursor });
    result.push(...page.keys.map(k => k.name));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return result;
}

// Called every 15 minutes: prepare yesterday's summary after 08:00 Jamaica time, then retry any unsent parts. The
// summary lists the orders paid that day, then those that reached WiPay that day and are still unpaid. Exact bodies
// are saved sealed (they hold customer details), so retries have stable content.
export async function dailyOrderSummary(c) {
  const local = new Date(+c.now - 5 * 3600000);
  if (local.getUTCHours() >= 8) {
    const yesterday = new Date(+local - 86400000).toISOString().slice(0, 10);
    const lastPrepared = await c.env.ORDERS.get('digest-last-prepared');
    let day = lastPrepared ? new Date(Date.parse(lastPrepared) + 86400000).toISOString().slice(0, 10) : yesterday;
    let preparedThrough = lastPrepared;
    // Catch up after missed cron runs. Bound each run, then resume from the cursor.
    for (let prepared = 0; day <= yesterday && prepared < 7; prepared++) {
      if (c.deadline && Date.now() >= c.deadline - 1000) break;
      const key = `digest-pending:${day}`;
      if (!await c.env.ORDERS.get(`digest-sent:${day}`) && !await c.env.ORDERS.get(key)) {
        const records = [];
        for (const name of await keys(c.env, `paid:${day}:`, c.deadline)) {
          if (c.deadline && Date.now() >= c.deadline - 1000) throw new Error('Daily summary preparation time budget reached; resume next run');
          const record = await findOrder(c.env, name.slice(`paid:${day}:`.length));
          // Missing indexed records indicate a storage outage; never send a partial summary.
          if (!record) throw new Error('Daily summary order unavailable');
          records.push(await revealOrder(c.env, record));
        }
        const unpaid = [];
        for (const name of await keys(c.env, `awaiting:${day}:`, c.deadline)) {
          const record = await findOrder(c.env, name.slice(`awaiting:${day}:`.length));
          if (record && record.paymentStatus !== 'PAID') unpaid.push(await revealOrder(c.env, record));
        }
        // shortcut: the unpaid section rides in part 1 whole; split it like the paid orders if it ever grows past ~20
        const unpaidHtml = unpaid.length ? `<h2>Reached WiPay, not paid (${unpaid.length})</h2><p>Match these against the WiPay dashboard before contacting the customer.</p>${unpaid.map(r => `<h3>${esc(r.id)}</h3>${table(recordRows(r))}`).join('')}` : '';
        const parts = [];
        const chunkSize = 20;
        for (let offset = 0; offset < Math.max(records.length, 1); offset += chunkSize) {
          if (c.deadline && Date.now() >= c.deadline - 1000) throw new Error('Daily summary preparation time budget reached; resume next run');
          const chunk = records.slice(offset, offset + chunkSize);
          const html = layout(`Orders for ${day}`, `<p>${records.length} paid orders. Collected: ${money(sum(records, 'totalCents'))} USD, including GCT ${money(sum(records, 'taxCents'))} and processing fees ${money(sum(records, 'feeCents'))}.</p>${chunk.length ? chunk.map(r => `<h2>${esc(r.id)}</h2>${table(recordRows(r))}`).join('') : '<p>No paid orders today.</p>'}${parts.length ? '' : unpaidHtml}`);
          parts.push({ sent: false, subject: `Evincus orders — ${day} (${records.length} orders) — part ${parts.length + 1}`, sealed: await seal(c.env, html) });
        }
        await c.env.ORDERS.put(key, JSON.stringify({ day, parts }), { expirationTtl: ORDER_TTL });
      }
      preparedThrough = day;
      day = new Date(Date.parse(day) + 86400000).toISOString().slice(0, 10);
    }
    if (preparedThrough !== lastPrepared) await c.env.ORDERS.put('digest-last-prepared', preparedThrough);
  }
  for (const key of await keys(c.env, 'digest-pending:', c.deadline)) {
    const job = await c.env.ORDERS.get(key, 'json');
    if (!job?.parts) continue;
    for (let i = 0; i < job.parts.length; i++) {
      if (c.deadline && Date.now() >= c.deadline - 1000) return;
      const part = job.parts[i];
      if (part.sent) continue;
      try {
        const html = part.sealed ? await unseal(c.env, part.sealed) : part.html; // parts saved before sealing are plaintext
        await sendEmail(c.env, { to: c.env.OWNER_EMAIL, subject: part.subject, html, idempotencyKey: `daily-orders-${job.day}-${i}` });
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
