// The "What's new" newsletter. Subscribers live in ORDERS KV as sub:<id> (double opt-in), with email and status
// also in the key's metadata so a send lists them without reading every value.
// Once a day after NEWSLETTER_HOUR (Jamaica time) the cron builds an issue from what changed since the last one.
// Nothing new means no email. An issue is saved with its recipient batches before anything is sent, and each
// batch uses a fixed idempotency key, so retries and overlapping cron runs never send a batch twice.
import { activeSales, applySales, publicView } from '../../data/catalog.js';
import { sendBatch } from './email.js';
import { loadSales } from './sales.js';
import { newsletterEmail, UNSUB } from '../emails/newsletter.js';
import { esc } from '../emails/html.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const JAMAICA = -5 * HOUR;
export const BATCH = 100;
export const MAX_ATTEMPTS = 12;
export const PENDING_TTL = 7 * 86400;

const enc = new TextEncoder();
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const normalizeEmail = v => {
  const e = typeof v === 'string' ? v.trim().toLowerCase() : '';
  return e.length <= 254 && EMAIL.test(e) ? e : null;
};

export const subKey = id => `sub:${id}`;
export const subscriberId = async email => hex(await crypto.subtle.digest('SHA-256', enc.encode(`newsletter|${email}`))).slice(0, 32);

async function key(env) {
  const secret = env.NEWSLETTER_KEY ?? env.ORDER_HMAC_KEY;
  if (!secret) throw new Error('NEWSLETTER_KEY not set');
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

// Confirm and unsubscribe links carry id + token, so they work without a login and can't be guessed.
export const linkToken = async (env, id) => b64url(await crypto.subtle.sign('HMAC', await key(env), enc.encode(`newsletter|${id}`)));

export async function verifyLink(env, id, token) {
  if (typeof id !== 'string' || !/^[0-9a-f]{32}$/.test(id) || typeof token !== 'string') return false;
  const want = await linkToken(env, id);
  if (want.length !== token.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ token.charCodeAt(i);
  return diff === 0;
}

export const siteUrl = env => String(env.SITE_URL ?? 'https://evincus.shop').replace(/\/+$/, '');
export const pageLink = (env, action, id, t) => `${siteUrl(env)}/newsletter.html?a=${action}&id=${id}&t=${encodeURIComponent(t)}`;

// ---------- what's new ----------

const t = iso => (iso ? Date.parse(iso) : null);
const inRange = (ms, from, to) => ms !== null && ms > from && ms <= to;

// Everything worth an email between `since` and `now`. Each item appears in one issue only:
// "soon" and "last call" windows are counted from `since`, so an item already announced isn't repeated.
export function buildIssue(data, sales, since, now) {
  const from = +since, to = +now;
  const priced = applySales(data, sales, now);
  const view = publicView(priced, now);
  const live = activeSales(sales, now);
  const drops = view.eras
    .filter(e => e.status === 'live' && inRange(t(e.dropsAt), from, to))
    .map(e => ({ era: e, products: view.products.filter(p => p.era === e.slug && p.buyable) }));
  const newSales = live.filter(s => inRange(t(s.startsAt), from, to));
  const soon = data.eras.filter(e => inRange(t(e.dropsAt), Math.max(to, from + 2 * DAY), to + 2 * DAY));
  const lastCall = live.filter(s => !newSales.includes(s) && inRange(t(s.endsAt), Math.max(to, from + DAY), to + DAY));
  const empty = !drops.length && !newSales.length && !soon.length && !lastCall.length;
  return { drops, sales: newSales, soon, lastCall, eras: data.eras, empty };
}

// ---------- subscribers ----------

export async function activeSubscribers(env) {
  const out = [];
  let cursor;
  do {
    const page = await env.ORDERS.list({ prefix: 'sub:', cursor });
    for (const k of page.keys) if (k.metadata?.status === 'active' && k.metadata.email) out.push({ id: k.name.slice(4), email: k.metadata.email });
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return out;
}

// ---------- the daily send ----------

const localDay = now => new Date(+now + JAMAICA).toISOString().slice(0, 10);
const localHour = now => new Date(+now + JAMAICA).getUTCHours();

async function prepare(c, day) {
  const since = Date.parse((await c.env.ORDERS.get('nl-last')) ?? '') || +c.now - 2 * DAY; // first issue: the last two days
  const sales = await loadSales(c.env, c.log);
  const issue = buildIssue(c.data, sales, since, c.now);
  if (issue.empty) {
    await c.env.ORDERS.put(`nl-done:${day}`, 'nothing-new', { expirationTtl: 30 * 86400 });
    await c.env.ORDERS.put('nl-last', c.now.toISOString());
    c.log.info('newsletter.skipped', { day });
    return;
  }
  const subs = await activeSubscribers(c.env);
  const { subject, html } = newsletterEmail(issue, { site: siteUrl(c.env), now: c.now, address: c.env.POSTAL_ADDRESS });
  const batches = [];
  for (let i = 0; i < subs.length; i += BATCH) batches.push({ to: subs.slice(i, i + BATCH), sent: false });
  await c.env.ORDERS.put(`nl-issue:${day}`, JSON.stringify({ day, subject, html, batches, attempts: 0 }), { expirationTtl: 7 * 86400 });
  await c.env.ORDERS.put('nl-last', c.now.toISOString());
  c.log.info('newsletter.prepared', { day, recipients: subs.length, batches: batches.length });
}

async function unsubHeaders(env, id, token) {
  const headers = { 'List-Unsubscribe': `<${pageLink(env, 'unsubscribe', id, token)}>` };
  if (env.API_URL) {
    headers['List-Unsubscribe'] = `<${String(env.API_URL).replace(/\/+$/, '')}/api/newsletter/unsubscribe?id=${id}&t=${encodeURIComponent(token)}>`;
    headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
  }
  return headers;
}

async function sendIssue(c, keyName) {
  const job = await c.env.ORDERS.get(keyName, 'json');
  if (!job?.batches) return;
  job.attempts += 1;
  for (let i = 0; i < job.batches.length; i++) {
    const batch = job.batches[i];
    if (batch.sent) continue;
    try {
      const emails = await Promise.all(batch.to.map(async s => {
        const token = await linkToken(c.env, s.id);
        return { to: s.email, subject: job.subject, html: job.html.replaceAll(UNSUB, esc(pageLink(c.env, 'unsubscribe', s.id, token))), headers: await unsubHeaders(c.env, s.id, token) };
      }));
      await sendBatch(c.env, emails, `newsletter-${job.day}-${i}`);
      batch.sent = true;
      c.log.info('newsletter.sent', { day: job.day, batch: i + 1, recipients: emails.length });
    } catch (err) {
      c.log.error('newsletter.failed', { day: job.day, batch: i + 1, attempts: job.attempts, message: String(err?.message ?? err) });
    }
  }
  const done = job.batches.every(b => b.sent);
  if (done || job.attempts >= MAX_ATTEMPTS) {
    await c.env.ORDERS.put(`nl-done:${job.day}`, done ? 'sent' : 'gave-up', { expirationTtl: 30 * 86400 });
    await c.env.ORDERS.delete(keyName);
    if (!done) c.log.error('newsletter.gave_up', { day: job.day });
  } else {
    await c.env.ORDERS.put(keyName, JSON.stringify(job), { expirationTtl: 7 * 86400 });
  }
}

// Called by every cron run. NEWSLETTER_HOUR unset or blank turns the newsletter off.
export async function newsletter(c) {
  const hour = Number(c.env.NEWSLETTER_HOUR);
  if (c.env.NEWSLETTER_HOUR === undefined || c.env.NEWSLETTER_HOUR === '' || !Number.isInteger(hour)) return;
  const day = localDay(c.now);
  if (localHour(c.now) >= hour && !(await c.env.ORDERS.get(`nl-done:${day}`)) && !(await c.env.ORDERS.get(`nl-issue:${day}`))) {
    await prepare(c, day);
  }
  const page = await c.env.ORDERS.list({ prefix: 'nl-issue:' });
  for (const k of page.keys) await sendIssue(c, k.name);
}
