import { sendEmail } from './email.js';
import { alertEmail } from '../emails/alert.js';

// Emails the owner. One alert per event per hour unless dedupe is false. Never throws.
export async function alert(c, event, { subject, rows = [], dedupe = true }) {
  try {
    const key = `alert:${event}`;
    if (dedupe && await c.env.ORDERS.get(key)) {
      c.log.info('alert.suppressed', { alertEvent: event });
      return;
    }
    await sendEmail(c.env, {
      to: c.env.OWNER_EMAIL,
      subject: `[Evincus alert] ${subject}`,
      html: alertEmail({ event, subject, rows, reqId: c.reqId, at: c.now }),
      idempotencyKey: `alert-${event}-${c.reqId}`,
    });
    if (dedupe) await c.env.ORDERS.put(key, '1', { expirationTtl: 3600 });
    c.log.info('alert.sent', { alertEvent: event });
  } catch (err) {
    c.log.error('alert.failed', { alertEvent: event, message: String(err?.message ?? err) });
  }
}

// Counts PayPal failures per 10-minute bucket; the 5th in a bucket alerts. Never throws.
export async function countPaypalError(c) {
  try {
    const key = `paypal-errors:${Math.floor(+c.now / 600000)}`;
    const n = Number((await c.env.ORDERS.get(key)) ?? 0) + 1;
    await c.env.ORDERS.put(key, String(n), { expirationTtl: 1200 });
    if (n === 5) await alert(c, 'paypal.burst', { subject: 'PayPal errors: checkout may be down', rows: [['Errors in this 10-minute window', '5 or more']] });
  } catch (err) {
    c.log.error('alert.failed', { alertEvent: 'paypal.burst', message: String(err?.message ?? err) });
  }
}
