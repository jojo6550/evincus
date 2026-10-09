import test from 'node:test';
import assert from 'node:assert/strict';
import { call, makeEnv, makeCtx, fakeUpstreams } from './helpers/fake-env.mjs';
import { FIXTURE, NOW } from './helpers/fixture.mjs';
import { createApp } from '../server/index.js';
import { buildIssue, linkToken, subKey, subscriberId, BATCH } from '../server/lib/newsletter.js';
import { SALES_KEY } from '../server/lib/sales.js';
import { UNSUB } from '../server/emails/newsletter.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const DROP = Date.parse(FIXTURE.eras[0].dropsAt); // 'future' drops 2026-10-10 17:00 Jamaica
const iso = ms => new Date(ms).toISOString();

async function cron(env, at) {
  const ctx = makeCtx();
  await createApp({ data: FIXTURE, clock: () => at }).scheduled({ cron: '*/15 * * * *', scheduledTime: at }, env, ctx);
  await ctx.settle();
}

const linkFrom = html => {
  const m = /newsletter\.html\?a=(\w+)&amp;id=([0-9a-f]+)&amp;t=([^"&]+)/.exec(html);
  return { action: m[1], id: m[2], t: decodeURIComponent(m[3]) };
};

async function addSubscriber(env, email, status = 'active') {
  const id = await subscriberId(email);
  await env.ORDERS.put(subKey(id), JSON.stringify({ email, status }), { metadata: { email, status } });
  return id;
}

const nlEnv = (over = {}) => makeEnv({ NEWSLETTER_HOUR: '10', SITE_URL: 'https://evincus.shop', ...over });

// ---------- subscribe, confirm, unsubscribe ----------

test('subscribe stores a pending address and emails a confirm link; confirming makes it active', async () => {
  const up = fakeUpstreams();
  const env = nlEnv();
  const res = await call('POST', '/api/newsletter/subscribe', { body: { email: '  Ann@Example.com ' }, env });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, { ok: true });

  const id = await subscriberId('ann@example.com');
  const stored = env.ORDERS.store.get(subKey(id));
  assert.equal(JSON.parse(stored.value).status, 'pending');
  assert.deepEqual(stored.opts.metadata, { email: 'ann@example.com', status: 'pending' });
  assert.ok(stored.opts.expirationTtl > 0, 'unconfirmed signups expire');

  assert.equal(up.emails.length, 1);
  assert.deepEqual(up.emails[0].to, ['ann@example.com']);
  const link = linkFrom(up.emails[0].html);
  assert.equal(link.action, 'confirm');
  assert.equal(link.id, id);

  const confirmed = await call('POST', '/api/newsletter/confirm', { body: { id: link.id, t: link.t }, env });
  assert.equal(confirmed.status, 200);
  const after = env.ORDERS.store.get(subKey(id));
  assert.equal(JSON.parse(after.value).status, 'active');
  assert.deepEqual(after.opts.metadata, { email: 'ann@example.com', status: 'active' });
  assert.equal(after.opts.expirationTtl, undefined);
});

test('subscribing an active address answers the same and sends nothing', async () => {
  const up = fakeUpstreams();
  const env = nlEnv();
  await addSubscriber(env, 'ann@example.com');
  const res = await call('POST', '/api/newsletter/subscribe', { body: { email: 'ann@example.com' }, env });
  assert.deepEqual(res.json, { ok: true });
  assert.equal(up.emails.length, 0);
});

test('bad emails are refused; the honeypot answers ok and stores nothing', async () => {
  const up = fakeUpstreams();
  const env = nlEnv();
  for (const email of ['nope', '', 'a@b', null, 'x'.repeat(250) + '@e.co']) {
    const res = await call('POST', '/api/newsletter/subscribe', { body: { email }, env });
    assert.equal(res.status, 400);
    assert.equal(res.json.error.code, 'invalid-email');
  }
  const bot = await call('POST', '/api/newsletter/subscribe', { body: { email: 'bot@example.com', company: 'Spam Inc' }, env });
  assert.equal(bot.status, 200);
  assert.equal([...env.ORDERS.store.keys()].filter(k => k.startsWith('sub:')).length, 0);
  assert.equal(up.emails.length, 0);
});

test('confirm and unsubscribe refuse forged or malformed links', async () => {
  const env = nlEnv();
  const id = await addSubscriber(env, 'ann@example.com', 'pending');
  const other = await linkToken(env, await subscriberId('someone@else.com'));
  for (const body of [{ id, t: other }, { id, t: '' }, { id: 'zz', t: other }, {}]) {
    assert.equal((await call('POST', '/api/newsletter/confirm', { body, env })).status, 400);
    assert.equal((await call('POST', '/api/newsletter/unsubscribe', { body, env })).status, 400);
  }
  assert.ok(env.ORDERS.store.has(subKey(id)));
});

test('one-click unsubscribe (query string, form body) removes the subscriber', async () => {
  const env = nlEnv();
  const id = await addSubscriber(env, 'ann@example.com');
  const t = await linkToken(env, id);
  const res = await call('POST', `/api/newsletter/unsubscribe?id=${id}&t=${encodeURIComponent(t)}`, {
    raw: 'List-Unsubscribe=One-Click', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, env,
  });
  assert.equal(res.status, 200);
  assert.ok(!env.ORDERS.store.has(subKey(id)));
});

// ---------- what's new ----------

const sale = (over = {}) => ({ id: 's1', percent: 25, eras: ['alpha'], label: null, startsAt: iso(NOW - HOUR), endsAt: iso(NOW + 3 * DAY), ...over });

test('buildIssue finds new drops, new sales, drops coming up and sales about to end', () => {
  const afterDrop = DROP + HOUR;
  const drop = buildIssue(FIXTURE, [], DROP - DAY, afterDrop);
  assert.deepEqual(drop.drops.map(d => [d.era.slug, d.products.map(p => p.id)]), [['future', ['future-tee']]]);

  const soon = buildIssue(FIXTURE, [], DROP - 3 * DAY, DROP - DAY);
  assert.deepEqual(soon.soon.map(e => e.slug), ['future']);
  assert.ok(buildIssue(FIXTURE, [], DROP - DAY, DROP - HOUR).empty, 'a drop announced yesterday is not repeated');

  const s = buildIssue(FIXTURE, [sale()], NOW - DAY, NOW);
  assert.deepEqual(s.sales.map(x => x.id), ['s1']);

  const ending = sale({ startsAt: iso(NOW - 5 * DAY), endsAt: iso(NOW + 10 * HOUR) });
  assert.deepEqual(buildIssue(FIXTURE, [ending], NOW - DAY, NOW).lastCall.map(x => x.id), ['s1']);
  assert.ok(buildIssue(FIXTURE, [ending], NOW - HOUR, NOW).empty, 'last call is sent once');

  assert.ok(buildIssue(FIXTURE, [], NOW - DAY, NOW).empty);
});

test('new-drop products show sale prices in the issue', () => {
  const issue = buildIssue(FIXTURE, [sale({ eras: ['future'], startsAt: iso(DROP), endsAt: iso(DROP + DAY) })], DROP - DAY, DROP + HOUR);
  const p = issue.drops[0].products[0];
  assert.equal(p.priceCents, 7499);
  assert.equal(p.compareAtCents, 9999);
});

// ---------- the daily send ----------

test('after the send hour, a new drop emails every active subscriber once with their own unsubscribe link', async () => {
  const up = fakeUpstreams();
  const env = nlEnv();
  const a = await addSubscriber(env, 'a@example.com');
  await addSubscriber(env, 'b@example.com');
  await addSubscriber(env, 'pending@example.com', 'pending');
  await env.ORDERS.put('nl-last', iso(DROP - DAY));

  await cron(env, DROP + HOUR);
  const sent = up.emails.filter(e => e.batch);
  assert.deepEqual(sent.map(e => e.to[0]).sort(), ['a@example.com', 'b@example.com']);
  assert.equal(sent[0].subject, 'New drop: Future is live');
  assert.ok(sent.every(e => !e.html.includes(UNSUB)));
  const mine = sent.find(e => e.to[0] === 'a@example.com');
  assert.equal(linkFrom(mine.html).id, a);
  assert.match(mine.headers['List-Unsubscribe'], /newsletter\.html\?a=unsubscribe/);
  assert.match(mine.html, /https:\/\/img\.test\/f\.png/);
  assert.equal(env.ORDERS.store.get(`nl-done:2026-10-10`).value, 'sent');

  await cron(env, DROP + 2 * HOUR);
  assert.equal(up.emails.filter(e => e.batch).length, 2, 'one issue per day');
});

test('one-click headers are added when API_URL is set', async () => {
  const up = fakeUpstreams();
  const env = nlEnv({ API_URL: 'https://api.evincus.test/' });
  await addSubscriber(env, 'a@example.com');
  await env.ORDERS.put('nl-last', iso(DROP - DAY));
  await cron(env, DROP + HOUR);
  const [e] = up.emails;
  assert.match(e.headers['List-Unsubscribe'], /^<https:\/\/api\.evincus\.test\/api\/newsletter\/unsubscribe\?id=[0-9a-f]{32}&t=/);
  assert.equal(e.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
});

test('before the send hour, or with nothing new, nothing is sent', async () => {
  const up = fakeUpstreams();
  const env = nlEnv({ NEWSLETTER_HOUR: '20' });
  await addSubscriber(env, 'a@example.com');
  await env.ORDERS.put('nl-last', iso(DROP - DAY));
  await cron(env, DROP + HOUR); // 18:00 Jamaica
  assert.equal(up.emails.length, 0);

  const quiet = nlEnv();
  await addSubscriber(quiet, 'a@example.com');
  await cron(quiet, NOW + 5 * HOUR); // 12:00 Jamaica, no news
  assert.equal(up.emails.length, 0);
  assert.equal(quiet.ORDERS.store.get('nl-done:2026-10-03').value, 'nothing-new');
});

test('a blank NEWSLETTER_HOUR turns the newsletter off', async () => {
  const up = fakeUpstreams();
  const env = nlEnv({ NEWSLETTER_HOUR: '' });
  await addSubscriber(env, 'a@example.com');
  await env.ORDERS.put('nl-last', iso(DROP - DAY));
  await cron(env, DROP + HOUR);
  assert.equal(up.emails.length, 0);
});

test('a sale goes out in batches of 100; a failed batch is retried later without resending the others', async () => {
  let failOnce = true;
  const up = fakeUpstreams({ resend: { fail: body => Array.isArray(body) && body.length === 50 && failOnce && !(failOnce = false) } });
  const env = nlEnv();
  for (let i = 0; i < BATCH + 50; i++) await addSubscriber(env, `u${String(i).padStart(3, '0')}@example.com`);
  env.ORDERS.store.set(SALES_KEY, { value: JSON.stringify([sale()]), opts: {} });
  await env.ORDERS.put('nl-last', iso(NOW - DAY));

  await cron(env, NOW + 4 * HOUR); // 11:00 Jamaica
  assert.equal(up.emails.length, BATCH, 'first batch sent, second failed');
  assert.match(up.emails[0].subject, /−25% off Alpha/);
  assert.ok(env.ORDERS.store.has('nl-issue:2026-10-03'));

  await cron(env, NOW + 4 * HOUR + 15 * 60_000);
  assert.equal(up.emails.length, BATCH + 50);
  assert.equal(new Set(up.emails.map(e => e.to[0])).size, BATCH + 50, 'nobody got it twice');
  assert.ok(!env.ORDERS.store.has('nl-issue:2026-10-03'));
  assert.equal(env.ORDERS.store.get('nl-done:2026-10-03').value, 'sent');
});
