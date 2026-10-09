import { json, fail, readJson } from '../lib/http.js';
import { sendEmail } from '../lib/email.js';
import { PENDING_TTL, linkToken, normalizeEmail, pageLink, siteUrl, subKey, subscriberId, verifyLink } from '../lib/newsletter.js';
import { confirmEmail } from '../emails/newsletter.js';

const ok = () => json({ ok: true }, 200, { 'Cache-Control': 'no-store' });

// POST /api/newsletter/subscribe { email }
// Always answers ok, so it can't be used to learn who is subscribed. New or unconfirmed addresses get a confirm email,
// at most one per address per hour (the idempotency key repeats within the hour).
export async function subscribeRoute(req, c) {
  if (c.env.ORDER_LIMIT) {
    const { success } = await c.env.ORDER_LIMIT.limit({ key: `newsletter:${c.ip}` });
    if (!success) return fail(c, 'rate-limited', 429);
  }
  const body = await readJson(req, 2048);
  if (body?.company) return ok(); // honeypot field real people never see
  const email = normalizeEmail(body?.email);
  if (!email) return fail(c, 'invalid-email', 400);

  const id = await subscriberId(email);
  const existing = await c.env.ORDERS.get(subKey(id), 'json');
  if (existing?.status === 'active') return ok();

  const link = pageLink(c.env, 'confirm', id, await linkToken(c.env, id));
  const record = { email, status: 'pending', createdAt: existing?.createdAt ?? c.now.toISOString() };
  await c.env.ORDERS.put(subKey(id), JSON.stringify(record), { metadata: { email, status: 'pending' }, expirationTtl: PENDING_TTL });
  c.waitUntil(sendEmail(c.env, { to: email, ...confirmEmail(link, siteUrl(c.env)), idempotencyKey: `newsletter-confirm-${id}-${Math.floor(+c.now / 3_600_000)}` })
    .then(() => c.log.info('newsletter.confirm_sent'))
    .catch(err => c.log.error('newsletter.confirm_failed', { message: String(err?.message ?? err) })));
  c.log.info('newsletter.subscribe', { returning: !!existing });
  return ok();
}

// id and t come from the query (one-click unsubscribe from the mail app) or the JSON body (newsletter.html).
async function linkParams(req) {
  const q = new URL(req.url).searchParams;
  if (q.get('id')) return { id: q.get('id'), t: q.get('t') };
  const body = await readJson(req, 2048);
  return { id: body?.id, t: body?.t };
}

// POST /api/newsletter/confirm { id, t }
export async function confirmRoute(req, c) {
  const { id, t } = await linkParams(req);
  if (!(await verifyLink(c.env, id, t))) return fail(c, 'newsletter-link', 400);
  const record = await c.env.ORDERS.get(subKey(id), 'json');
  if (!record) return fail(c, 'newsletter-link', 404);
  if (record.status !== 'active') {
    const active = { ...record, status: 'active', confirmedAt: c.now.toISOString() };
    await c.env.ORDERS.put(subKey(id), JSON.stringify(active), { metadata: { email: record.email, status: 'active' } });
    c.log.info('newsletter.confirmed');
  }
  return ok();
}

// POST /api/newsletter/unsubscribe { id, t }, or ?id=&t= for List-Unsubscribe-Post one-click.
export async function unsubscribeRoute(req, c) {
  const { id, t } = await linkParams(req);
  if (!(await verifyLink(c.env, id, t))) return fail(c, 'newsletter-link', 400);
  await c.env.ORDERS.delete(subKey(id));
  c.log.info('newsletter.unsubscribed');
  return ok();
}
