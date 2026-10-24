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
  const secret = env.NEWSLETTER_KEY;
  if (!secret) throw new Error('NEWSLETTER_KEY not set');
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

// Confirm and unsubscribe links carry id + token, so they work without a login and can't be guessed.
export const linkToken = async (env, id, generation = '') => b64url(await crypto.subtle.sign('HMAC', await key(env), enc.encode(`newsletter|${id}${generation ? `|${generation}` : ''}`)));

export async function verifyLink(env, id, token) {
  if (typeof id !== 'string' || !/^[0-9a-f]{32}$/.test(id) || typeof token !== 'string') return false;
  const record = await env.ORDERS.get(subKey(id), 'json');
  if (!record) return false;
  const want = await linkToken(env, id, record.generation);
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

const TTL = { expirationTtl: 7 * 86400 };
const batchKey = (day, i) => `nl-batch:${day}:${String(i).padStart(8, '0')}`;
const hasTime = c => !c.deadline || Date.now() < c.deadline - 1000;

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
  const { subject, html } = newsletterEmail(issue, { site: siteUrl(c.env), now: c.now, address: c.env.POSTAL_ADDRESS });
  await c.env.ORDERS.put(`nl-issue:${day}`, JSON.stringify({ day, subject, html, site: siteUrl(c.env), api: c.env.API_URL, from: c.env.EMAIL_FROM, format: 2, batchCount: 0, nextBatch: 0, cursor: null, prepared: false, through: c.now.toISOString() }), TTL);
}

// Recipient snapshots are bounded records, not one ever-growing issue value.
// Save the cursor and its batches atomically so a restart cannot omit a page.
async function prepareRecipients(c, keyName, job) {
  for (let pages = 0; !job.prepared && pages < 10 && hasTime(c); pages++) {
    const page = await c.env.ORDERS.list({ prefix: 'sub:', cursor: job.cursor || undefined, limit: BATCH });
    const active = page.keys.filter(k => k.metadata?.status === 'active' && k.metadata.email)
      .map(k => ({ id: k.name.slice(4), email: k.metadata.email }));
    const puts = [];
    for (let i = 0; i < active.length; i += BATCH) {
      puts.push({ key: batchKey(job.day, job.batchCount++), value: JSON.stringify({ to: active.slice(i, i + BATCH), attempts: 0 }), opts: TTL });
    }
    job.prepared = page.list_complete;
    job.cursor = page.list_complete ? null : page.cursor;
    puts.push({ key: keyName, value: JSON.stringify(job), opts: TTL });
    if (job.prepared) puts.push({ key: 'nl-last', value: job.through });
    if (!await c.env.ORDERS.commit({ puts })) throw new Error('Newsletter preparation conflict');
  }
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
  if (!job) return;
  // Finish existing issues after deploying the storage change, keeping their
  // original provider idempotency keys and already-sent markers.
  if (job.batches) {
    for (let i = 0; i < job.batches.length; i++) {
      await c.env.ORDERS.put(batchKey(job.day, i), JSON.stringify({ ...job.batches[i], attempts: job.attempts ?? 0, attempted: (job.attempts ?? 0) > 0 }), TTL);
    }
    job.batchCount = job.batches.length; job.nextBatch = 0; job.prepared = true; job.format = 2;
    delete job.batches;
    await c.env.ORDERS.put(keyName, JSON.stringify(job), TTL);
  }
  if (!job.prepared) await prepareRecipients(c, keyName, job);
  if (!job.prepared) return;
  for (let work = 0; job.nextBatch < job.batchCount && work < 5 && hasTime(c); work++) {
    const i = job.nextBatch;
    const name = batchKey(job.day, i);
    const batch = await c.env.ORDERS.get(name, 'json');
    if (!batch) throw new Error('Newsletter recipient batch unavailable');
    if (batch.sent) {
      job.nextBatch++;
      await c.env.ORDERS.commit({ puts: [{ key: keyName, value: JSON.stringify(job), opts: TTL }], deletes: [name] });
      continue;
    }
    batch.attempts += 1;
    try {
      const selected = [];
      for (const s of batch.to) {
        const record = await c.env.ORDERS.get(subKey(s.id), 'json');
        if (record?.status === 'active' && record.email === s.email && (!batch.attempted || s.generation === record.generation)) selected.push({ ...s, generation: record.generation });
      }
      // An ambiguous provider failure may already have sent the original batch.
      // Never change its payload/key and risk duplicates, or send to someone who
      // has since unsubscribed. Retire that batch; the next issue includes the
      // remaining active subscribers again.
      if (batch.attempted && selected.length !== batch.to.length) {
        c.log.warn('newsletter.consent_changed', { day: job.day, batch: i + 1 });
        job.consentChanged = true;
        batch.sent = true;
      } else if (!selected.length) batch.sent = true;
      else {
        batch.to = await Promise.all(selected.map(async s => ({ ...s, token: s.token ?? await linkToken(c.env, s.id, s.generation) })));
        const linkEnv = { SITE_URL: job.site ?? siteUrl(c.env), API_URL: job.api ?? c.env.API_URL };
        const emails = await Promise.all(batch.to.map(async s => ({
          to: s.email, subject: job.subject,
          html: job.html.replaceAll(UNSUB, esc(pageLink(linkEnv, 'unsubscribe', s.id, s.token))),
          headers: await unsubHeaders(linkEnv, s.id, s.token),
        })));
        // Keep large HTML out of recipient records: the issue body is immutable,
        // and per-recipient generations above make rendering deterministic.
        batch.attempted = true;
        await c.env.ORDERS.put(name, JSON.stringify(batch), TTL);
        await sendBatch({ ...c.env, EMAIL_FROM: job.from ?? c.env.EMAIL_FROM }, emails, `newsletter-${job.day}-${i}`);
        batch.sent = true;
        c.log.info('newsletter.sent', { day: job.day, batch: i + 1, recipients: emails.length });
      }
    } catch (err) {
      c.log.error('newsletter.failed', { day: job.day, batch: i + 1, attempts: batch.attempts, message: String(err?.message ?? err) });
    }
    if (batch.sent || batch.attempts >= MAX_ATTEMPTS) {
      if (!batch.sent) { job.failed = true; c.log.error('newsletter.gave_up', { day: job.day, batch: i + 1 }); }
      job.nextBatch++;
      await c.env.ORDERS.commit({ puts: [{ key: keyName, value: JSON.stringify(job), opts: TTL }], deletes: [name] });
    } else {
      await c.env.ORDERS.put(name, JSON.stringify(batch), TTL);
      break;
    }
  }
  if (job.nextBatch === job.batchCount) {
    await c.env.ORDERS.put(`nl-done:${job.day}`, job.failed ? 'gave-up' : job.consentChanged ? 'consent-changed' : 'sent', { expirationTtl: 30 * 86400 });
    await c.env.ORDERS.delete(keyName);
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
  for (const k of page.keys) { if (!hasTime(c)) break; await sendIssue(c, k.name); }
}
