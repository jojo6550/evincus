import test from 'node:test';
import assert from 'node:assert/strict';
import { call, makeEnv } from './helpers/fake-env.mjs';
import { signIn, ADMIN_TOKEN } from './helpers/staff.mjs';
import { orderPuts, refundKey, bumpOrders } from '../server/lib/orders.js';
import { paidKey } from '../server/lib/payments.js';
import { seal } from '../server/lib/crypto.js';
import { finances, financesCsv } from '../server/lib/finances.js';

const NOW = new Date('2026-10-31T17:00:00Z');
const OCT = { from: '2026-10-01', to: '2026-10-31', now: NOW };
// A paid order, its paid: entry on `paidDay`, and refund events + refund: entries. Money in cents.
async function seed(env, { id, placedDay = '2026-10-02', paidDay, lines, totalCents, taxCents, refunds = [] }) {
  const paidAt = `${paidDay}T15:00:00.000Z`;
  const subtotalCents = lines.reduce((n, l) => n + l.unitCents * l.qty, 0);
  const events = [{ at: `${placedDay}T14:00:00.000Z`, type: 'placed', by: null }, ...refunds.map(r => ({ at: `${r.day}T16:00:00.000Z`, type: 'refund', by: 'o@x', restock: r.restock, lines: r.lines, amountCents: r.amountCents, taxCents: r.taxCents, reason: r.reason }))];
  const o = {
    id, status: 'PLACED', paymentStatus: refunds.length ? 'PARTIALLY_REFUNDED' : 'PAID', placedAt: `${placedDay}T14:00:00.000Z`, fulfilmentStatus: 'FULFILLED', stockCommitted: true,
    fulfillment: { type: 'pickup', location: { id: 'trendy-hats' } }, lines, subtotalCents, taxCents, feeCents: 0, taxBps: 1500, feeBps: 483, totalCents,
    payment: { provider: 'wipay', transactionId: `SB-1-1-${id}-20261001000000`, paidAt }, events,
    refundedCents: refunds.reduce((n, r) => n + r.amountCents, 0),
    pii: await seal(env, { customer: { firstName: 'Ann', lastName: 'Lee', email: 'ann@example.com', phone: '876 555 0142' }, address: { line1: '9 Hope Rd', city: 'Kingston', country: 'JM' }, notes: 'secret note' }),
  };
  await env.ORDERS.commit({ puts: [
    ...orderPuts(o),
    { key: paidKey(paidDay, id), value: '', opts: { metadata: { totalCents, taxCents, feeCents: 0, paidAt } } },
    ...events.filter(e => e.type === 'refund').map((e, i) => ({ key: refundKey(e.at.slice(0, 10), id, e.at, `op${i}`), value: '', opts: { metadata: { amountCents: e.amountCents, taxCents: e.taxCents, restock: e.restock, lines: e.lines } } })),
  ] });
  bumpOrders(); // as every order write does
}
const line = (id, name, qty, unitCents, costCents) => ({ key: `${id}|Black|M`, id, name, color: 'Black', size: 'M', qty, unitCents, ...(costCents !== undefined && { costCents }) });

// The mockup's October: revenue $4,812.40, refunds $84.52, GCT owed $587.76, fees $232.44, COGS $1,402.00, profit $2,505.68.
async function october(env) {
  await seed(env, { id: 'EV-big', paidDay: '2026-10-05', totalCents: 481240, taxCents: 59878, lines: [line('disaster-zone-tee', 'Disaster Zone Tee', 1, 403602, 140200)],
    refunds: [{ day: '2026-10-20', amountCents: 4226, taxCents: 551, restock: false, lines: [{ key: 'disaster-zone-tee|Black|M', qty: 0 }], reason: 'Wrong size' }, { day: '2026-10-21', amountCents: 4226, taxCents: 551, restock: false, lines: [], reason: 'Changed mind' }] });
}

test('October reproduces the mockup: revenue, refunds, net, GCT owed, fees, cost, profit and margin', async () => {
  const env = makeEnv(); await october(env);
  const f = await finances(env, OCT);
  assert.deepEqual([f.empty, f.revenueCents, f.refundsCents, f.netCents, f.gctOwedCents, f.feesCents, f.cogsCents, f.profitCents], [false, 481240, 8452, 472788, 58776, 23244, 140200, 250568]);
  assert.equal(f.marginBps, Math.round(250568 * 10000 / 472788)); // 53%
  assert.deepEqual(f.refunds.map(r => [r.orderId, r.reason, r.amountCents]), [['EV-big', 'Changed mind', 4226], ['EV-big', 'Wrong size', 4226]]);
});

test('paid day and refund day decide the month; fees ignore refunds; by-month rows add up', async () => {
  const env = makeEnv();
  await seed(env, { id: 'EV-sep', placedDay: '2026-09-29', paidDay: '2026-10-01', totalCents: 10000, taxCents: 1200, lines: [line('a', 'A', 2, 4000, 1000)] });
  await seed(env, { id: 'EV-nov', paidDay: '2026-10-10', totalCents: 20000, taxCents: 2400, lines: [line('b', 'B', 1, 16000, 5000), line('c', 'C', 1, 1000)],
    refunds: [{ day: '2026-11-02', amountCents: 5000, taxCents: 600, restock: true, lines: [{ key: 'b|Black|M', qty: 1 }], reason: 'Broken zip' }] });
  const oct = await finances(env, OCT);
  assert.equal(oct.revenueCents, 30000, 'placed in September, paid in October: October');
  assert.equal(oct.refundsCents, 0, 'a November refund leaves October alone');
  assert.equal(oct.feesCents, 483 + 966);
  assert.equal(oct.costMissing, 1);
  const nov = await finances(env, { from: '2026-11-01', to: '2026-11-30', now: NOW });
  assert.deepEqual([nov.revenueCents, nov.refundsCents, nov.gctOwedCents], [0, 5000, -600]);
  const both = await finances(env, { from: '2026-10-01', to: '2026-11-30', now: NOW });
  for (const k of ['revenueCents', 'gctOwedCents', 'profitCents']) assert.equal(both.months.reduce((n, m) => n + m[k], 0), both[k], k);
  assert.equal(both.cogsCents, 2000 + 0, 'the restocked refunded unit is not a cost; a line without cost counts 0');
});

test('best sellers are sorted by profit', async () => {
  const env = makeEnv();
  await seed(env, { id: 'EV-1', paidDay: '2026-10-03', totalCents: 9200, taxCents: 1200, lines: [line('a', 'A', 1, 3000, 2500), line('b', 'B', 1, 5000, 1000)] });
  const f = await finances(env, OCT);
  assert.deepEqual(f.bestSellers.map(b => b.id), ['b', 'a']);
  assert.deepEqual(Object.keys(f.bestSellers[0]).sort(), ['id', 'name', 'profitCents', 'revenueCents', 'units']);
});

test('empty until the first payment, whatever the period', async () => {
  const env = makeEnv();
  assert.equal((await finances(env, OCT)).empty, true);
  await seed(env, { id: 'EV-1', paidDay: '2026-08-03', totalCents: 100, taxCents: 10, lines: [line('a', 'A', 1, 90, 10)] });
  assert.equal((await finances(env, OCT)).empty, false);
});

test('the CSV has a row per paid order and per refund, and nothing personal', async () => {
  const env = makeEnv(); await october(env);
  const csv = await financesCsv(env, OCT);
  assert.match(csv, /^id,paidAt,subtotalCents,taxCents,feeCents,totalCents,cogsCents,refundedCents\r?\n/);
  assert.match(csv, /EV-big,2026-10-05T15:00:00.000Z,403602,59878,23244,481240,140200,8452/);
  assert.equal((csv.match(/^EV-big,2026-10-2\dT/gm) ?? []).length, 2);
  for (const s of ['ann@example.com', 'Ann', 'Lee', '555', 'Hope Rd', 'secret note', 'pii', 'Wrong size']) assert.ok(!csv.includes(s), s);
});

test('routes: owners only, bad ranges are 400', async () => {
  const env = makeEnv({ ADMIN_TOKEN }); await october(env);
  const owner = await signIn(env), viewer = await signIn(env, 'viewer');
  const get = (cookie, path) => call('GET', path, { env, headers: { cookie } }); // the sign-in clock, so the session is live
  const r = await get(owner, '/api/inventory/finances?from=2026-10-01&to=2026-10-31');
  assert.equal(r.status, 200);
  assert.equal(r.json.profitCents, 250568);
  const csv = await get(owner, '/api/inventory/finances.csv?from=2026-10-01&to=2026-10-31');
  assert.equal(csv.status, 200);
  assert.match(csv.res.headers.get('content-type'), /text\/csv/);
  assert.match(csv.res.headers.get('content-disposition'), /attachment/);
  for (const path of ['/api/inventory/finances', '/api/inventory/finances.csv']) assert.equal((await get(viewer, path)).status, 403, path);
  for (const q of ['?from=2026-13-01&to=2026-10-31', '?from=2026-10-31&to=2026-10-01', '?from=2024-01-01&to=2026-10-31', '?from=x']) {
    assert.equal((await get(owner, `/api/inventory/finances${q}`)).status, 400, q);
  }
  assert.equal((await get(owner, '/api/inventory/finances')).status, 200, 'no range: this month');
});
