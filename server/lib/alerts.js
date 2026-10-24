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
