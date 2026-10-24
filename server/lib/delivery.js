import { sendEmail } from './email.js';
import { alert } from './alerts.js';
import { findOrder, updateOrder, retryKey } from './orders.js';
import { receiptEmail } from '../emails/receipt.js';

export const BACKOFF_MINUTES = [15, 30, 60, 120, 240];
const MIN = 60_000;

// Sends the receipt if it isn't sent yet and updates record.email. True once it is sent. The owner gets the daily summary.
export async function deliverOrderEmails(c, record) {
  const attempt = record.email.attempts + 1;
  const jobs = [
    ['customer', record.payer.email, () => receiptEmail(record)],
  ];
  for (const [recipient, to, build] of jobs) {
    if (record.email[recipient] === 'sent') continue;
    try {
      await sendEmail(c.env, { to, ...build(), idempotencyKey: `${record.id}-${recipient}` });
      record.email[recipient] = 'sent';
      c.log.info('email.sent', { orderId: record.id, recipient, attempts: attempt });
    } catch (err) {
      record.email[recipient] = 'failed';
      c.log.warn('email.failed', { orderId: record.id, recipient, attempts: attempt, message: String(err?.message ?? err) });
    }
  }
  record.email.attempts = attempt;
  return record.email.customer === 'sent';
}

// First delivery, right after the order is placed.
// The retry key is written before the record update, and separately, so a failed update can't lose the retry.
export async function sendOrderEmails(c, record) {
  let done;
  try {
    done = await deliverOrderEmails(c, record);
  } catch (err) {
    c.log.error('email.failed', { orderId: record.id, message: String(err?.message ?? err) });
  }
  if (!done) {
    try {
      await c.env.ORDERS.put(retryKey(record.id), JSON.stringify({ retries: 0, nextAt: +c.now + BACKOFF_MINUTES[0] * MIN }));
    } catch (err) {
      c.log.error('email.failed', { orderId: record.id, message: String(err?.message ?? err) });
    }
  }
  try {
    await updateOrder(c.env, record);
    if (done) await c.env.ORDERS.delete(retryKey(record.id));
  } catch (err) {
    c.log.error('email.failed', { orderId: record.id, message: String(err?.message ?? err) });
  }
}

async function retryOne(c, id) {
  const key = retryKey(id);
  const state = await c.env.ORDERS.get(key, 'json');
  if (!state || state.nextAt > +c.now) return;
  const record = await findOrder(c.env, id);
  if (!record) { await c.env.ORDERS.delete(key); return; }

  const done = await deliverOrderEmails(c, record);
  await updateOrder(c.env, record);
  if (done) { await c.env.ORDERS.delete(key); return; }

  const retries = state.retries + 1;
  if (retries >= BACKOFF_MINUTES.length) {
    c.log.error('email.gave_up', { orderId: id, attempts: record.email.attempts });
    await c.env.ORDERS.delete(key);
    await alert(c, 'email.gave_up', {
      subject: `Receipt not delivered for order ${id}`,
      rows: [['Order', id], ['Customer email', record.email.customer], ['Attempts', String(record.email.attempts)]],
    });
    return;
  }
  await c.env.ORDERS.put(key, JSON.stringify({ retries, nextAt: +c.now + BACKOFF_MINUTES[retries] * MIN }));
}

// Cron: every 15 minutes, retry due email deliveries. One bad order never blocks the rest.
export async function retryEmails(c) {
  let cursor;
  do {
    const page = await c.env.ORDERS.list({ prefix: 'email-retry:', cursor });
    for (const { name } of page.keys) {
      if (c.deadline && Date.now() >= c.deadline - 1000) return;
      const id = name.slice('email-retry:'.length);
      try { await retryOne(c, id); } catch (err) { c.log.error('email.failed', { orderId: id, message: String(err?.message ?? err) }); }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
}
