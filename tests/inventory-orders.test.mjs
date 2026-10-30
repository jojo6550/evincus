import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { actionsFor, actionLabel, refundLeft, newOrderPage, runAction, reloadOrder, locked, listPath } from '../assets/js/inventory-orders.js';
import * as refunds from '../data/refunds.js';
import { applyAction, defaultRefundCents } from '../server/lib/order-flow.js';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

// Answers each request with the next [status, body] for its method ('lost' drops the connection); records every call.
const stub = replies => {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : undefined });
    const reply = replies[init.method].shift();
    if (reply === 'lost') throw new TypeError('Failed to fetch');
    const [status, body] = reply;
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  };
  return calls;
};
const fail = (status, code, extra) => [status, { error: { code, message: `${code}.`, requestId: 'r', ...extra } }];

const A = 'a|White|S', B = 'b|Black|M';
const mk = (over = {}) => ({
  id: 'EV-1', status: 'PLACED', paymentStatus: 'PAID', placedAt: '2026-10-01T12:00:00.000Z', subtotalCents: 10000, taxCents: 1000, feeCents: 300,
  totalCents: 11300, stockCommitted: true, fulfillment: { type: 'pickup', location: { id: 'trendy-hats' } },
  lines: [{ key: A, qty: 2, unitCents: 3000 }, { key: B, qty: 1, unitCents: 4000 }], events: [], ...over,
});
const OWNER = 'owner', VIEWER = 'viewer';

test('actionsFor offers ready only on pickup orders and nothing after fulfilment, and nothing to viewers', () => {
  const at = (over, role = OWNER) => actionsFor(mk(over), role);
  assert.deepEqual(at({}), ['ready', 'fulfilled', 'refund', 'cancel']);
  assert.deepEqual(at({ paymentStatus: 'NOT_COLLECTED' }), ['ready', 'fulfilled', 'cancel'], 'no refund on an order never charged');
  assert.deepEqual(at({ fulfilmentStatus: 'READY' }), ['fulfilled', 'refund', 'cancel']);
  assert.deepEqual(at({ fulfillment: { type: 'shipping' } }), ['fulfilled', 'refund', 'cancel'], 'shipping skips ready');
  assert.deepEqual(at({ fulfilmentStatus: 'FULFILLED', paymentStatus: 'NOT_COLLECTED' }), []);
  assert.deepEqual(at({ fulfilmentStatus: 'FULFILLED' }), ['refund'], 'a picked-up paid order can still be refunded');
  assert.deepEqual(at({ fulfilmentStatus: 'CANCELLED' }), ['refund'], 'a cancelled paid order needs its refund recorded');
  assert.deepEqual(at({ fulfilmentStatus: 'CANCELLED', paymentStatus: 'NOT_COLLECTED' }), []);
  assert.deepEqual(at({ paymentStatus: 'REFUNDED' }), ['ready', 'fulfilled', 'cancel']);
  assert.deepEqual(at({ paymentStatus: 'PARTIALLY_REFUNDED', refundedQty: { [A]: 2, [B]: 1 } }), ['ready', 'fulfilled', 'cancel'], 'nothing left to refund');
  for (const over of [{}, { fulfilmentStatus: 'READY' }, { fulfillment: { type: 'shipping' } }]) assert.deepEqual(at(over, VIEWER), []);
  assert.equal(actionLabel(mk(), 'fulfilled'), 'Mark picked up');
  assert.equal(actionLabel(mk({ fulfillment: { type: 'shipping' } }), 'fulfilled'), 'Mark shipped');
  assert.equal(actionLabel(mk(), 'ready'), 'Mark ready for pickup');
});

test('actionsFor matches what the server allows in every state', () => {
  const now = new Date('2026-10-02T00:00:00Z');
  const tries = {
    ready: { type: 'ready' }, fulfilled: { type: 'fulfilled' }, cancel: { type: 'cancel', restock: true },
    refund: { type: 'refund', lines: [{ key: B, qty: 1 }], amountCents: 1, restock: true, reason: 'x' },
  };
  for (const type of ['pickup', 'shipping'])
    for (const fulfilmentStatus of ['UNFULFILLED', 'READY', 'FULFILLED', 'CANCELLED', undefined])
      for (const paymentStatus of ['PAID', 'NOT_COLLECTED', 'UNPAID', 'PARTIALLY_REFUNDED', 'REFUNDED']) {
        if (type === 'shipping' && fulfilmentStatus === 'READY') continue; // unreachable
        const o = mk({ fulfillment: { type }, fulfilmentStatus, paymentStatus });
        const allowed = Object.keys(tries).filter(a => { try { applyAction(o, tries[a], { now }); return true; } catch { return false; } });
        assert.deepEqual([...actionsFor(o, OWNER)].sort(), allowed.sort(), JSON.stringify({ type, fulfilmentStatus, paymentStatus }));
      }
});

test('the refund math lives in data/refunds.js, gives the server’s default and returns null where the server refuses', async () => {
  const src = await readFile(new URL('../data/refunds.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /from ['"][^'"]*server\//);
  assert.doesNotMatch(src, /HttpError/);
  const picks = [[{ key: A, qty: 1 }], [{ key: A, qty: 2 }, { key: B, qty: 1 }], [{ key: A, qty: 1 }, { key: A, qty: 1 }], [{ key: B, qty: 1 }]];
  for (const r of [mk(), mk({ refundedQty: { [A]: 1 }, refundedCents: 3300, refundedTaxCents: 300 }), mk({ taxCents: 0, feeCents: 0, totalCents: 10000 })])
    for (const lines of picks) {
      let server = null;
      try { server = defaultRefundCents(r, lines); } catch { /* refused */ }
      assert.equal(refunds.defaultRefundCents(r, lines), server, JSON.stringify({ r: r.refundedQty, lines }));
    }
  assert.equal(refunds.defaultRefundCents(mk(), [{ key: A, qty: 2 }]), 6600);
  for (const bad of [[], null, [{ key: 'nope', qty: 1 }], [{ key: A, qty: 3 }], [{ key: A, qty: 0 }]]) {
    assert.equal(refunds.defaultRefundCents(mk(), bad), null);
    assert.throws(() => defaultRefundCents(mk(), bad), { code: 'invalid-action' });
  }
});

test('the refund window shows only for orders with paidAt and runs 24 hours', () => {
  const now = Date.parse('2026-10-02T15:00:00Z');
  assert.equal(refundLeft(undefined, now), null, 'NOT_COLLECTED orders have no paidAt');
  assert.equal(refundLeft('2026-10-02T12:00:00Z', now), '21h left');
  assert.equal(refundLeft('2026-10-01T15:20:00Z', now), '20m left');
  assert.equal(refundLeft('2026-10-01T14:00:00Z', now), null, 'window over');
});

test('listPath sends only the filters set', () => {
  assert.equal(listPath({ view: 'open', q: ' ', from: '', to: '', location: '', payment: '', product: '' }), '/api/inventory/orders?view=open');
  assert.equal(listPath({ view: 'all', q: 'ann lee', location: 'trendy-hats' }, '2026|EV-1'), '/api/inventory/orders?view=all&q=ann+lee&location=trendy-hats&cursor=2026%7CEV-1');
});

const page = (over = {}) => newOrderPage({ id: 'EV-1', d: { order: mk(), version: 'v1', covers: {} }, who: { email: 'o@x', role: 'owner' }, ...over });
const reply = (order, version) => [200, { order, version }];

test('a lost reply keeps the opId for Retry and locks the actions until it is resolved', async () => {
  const pg = page();
  const ready = mk({ fulfilmentStatus: 'READY' });
  const calls = stub({ POST: ['lost', fail(503, 'server-error'), fail(401, 'signed-out'), reply(ready, 'v2')] });
  await runAction(pg, { type: 'ready' });
  assert.ok(pg.lost);
  assert.ok(locked(pg));
  assert.match(pg.msg, /couldn’t confirm/i);
  assert.equal(pg.order.fulfilmentStatus ?? 'UNFULFILLED', 'UNFULFILLED');

  await runAction(pg, { type: 'cancel', restock: true });
  assert.equal(calls.length, 1, 'another action waits for the lost one');
  assert.match(pg.msg, /Retry it or reload/);

  await runAction(pg, pg.lost.action); // Retry: 503, still unknown
  assert.ok(locked(pg));
  await runAction(pg, pg.lost.action); // 401 comes before the op lookup, so it settles nothing
  assert.ok(locked(pg));
  await runAction(pg, pg.lost.action);
  assert.equal(pg.lost, null);
  assert.equal(locked(pg), false);
  assert.equal(pg.order.fulfilmentStatus, 'READY');
  assert.equal(pg.version, 'v2');
  assert.equal(calls.length, 4);
  assert.equal(new Set(calls.map(c => c.body.opId)).size, 1, 'one opId for every retry');
  assert.ok(calls.every(c => c.body.version === 'v1' && c.url === '/api/inventory/orders/EV-1/actions'));
});

test('a reload settles a lost reply; the next action gets a new opId', async () => {
  const pg = page();
  const calls = stub({ POST: ['lost', reply(mk({ fulfilmentStatus: 'READY' }), 'v3')], GET: [[200, { order: mk(), version: 'v2', covers: {} }]] });
  await runAction(pg, { type: 'ready' });
  await reloadOrder(pg);
  assert.equal(pg.lost, null);
  assert.equal(pg.version, 'v2');
  await runAction(pg, { type: 'ready' });
  const posts = calls.filter(c => c.method === 'POST');
  assert.notEqual(posts[0].body.opId, posts[1].body.opId);
  assert.equal(posts[1].body.version, 'v2');
});

test('order-changed shows the current order and says so; other refusals say why in plain words', async () => {
  const pg = page();
  const current = mk({ fulfilmentStatus: 'READY', events: [{ type: 'ready' }] });
  stub({ POST: [fail(409, 'order-changed', { current, version: 'v9' }), fail(409, 'stock-short', { key: A }), fail(409, 'variant-gone', { key: A })] });
  await runAction(pg, { type: 'ready' });
  assert.deepEqual(pg.order, current);
  assert.equal(pg.version, 'v9');
  assert.match(pg.msg, /changed since you opened it/);
  assert.equal(pg.lost, null);
  await runAction(pg, { type: 'fulfilled' });
  assert.match(pg.msg, /enough stock/);
  await runAction(pg, { type: 'cancel', restock: true });
  assert.match(pg.msg, /colour or size no longer exists/i);
  assert.equal(locked(pg), false);
});

test('the order page escapes customer text, hides customer details from viewers and says when they were removed', async () => {
  const view = await import('../assets/js/inventory-orders-view.js');
  const evil = '<img src=x onerror=alert(1)>';
  const o = mk({
    customer: { name: evil, phone: '876', email: 'a@b.co' }, notes: evil,
    payment: { provider: 'wipay', transactionId: evil, paidAt: new Date(Date.now() - 3 * 3600000).toISOString() },
    lines: [{ key: A, name: evil, color: 'White', size: 'S', qty: 1, unitCents: 3000, costCents: 1000 }],
    events: [{ at: '2026-10-01T12:00:00Z', type: 'note', text: evil, by: 'o@x' }, { at: '2026-10-01T12:00:00Z', type: 'refund', reason: evil, amountCents: 100 }],
  });
  const html = role => {
    const pg = newOrderPage({ id: o.id, d: { order: o, version: 'v' }, who: { email: 'x', role } });
    const actions = actionsFor(pg.order, pg.role);
    return view.pageHtml(pg, { actions, labels: Object.fromEntries(actions.map(a => [a, actionLabel(o, a)])), left: p => refundLeft(p), max: null });
  };
  const owner = html('owner');
  assert.ok(!owner.includes('<img src=x'), 'no raw customer HTML');
  assert.match(owner, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(owner, /Your cost of goods/);
  assert.match(owner, /data-act="cancel"/);
  assert.match(owner, /Refund window/);
  assert.doesNotMatch(html('viewer'), /data-act=|Your cost of goods|Internal note|a@b\.co/);
  const scrubbed = newOrderPage({ id: 'x', d: { order: mk({ scrubbedAt: 'x' }), version: 'v', scrubbed: true }, who: { role: 'owner' } });
  assert.match(view.pageHtml(scrubbed, { actions: [], labels: {}, left: () => null, max: null }), /Customer details removed after 2 years/);
  const row = { id: 'EV-1', totalCents: 100, payment: 'NOT_COLLECTED', fulfilment: 'UNFULFILLED', type: 'pickup', locationId: 'trendy-hats', units: 1, placedAt: new Date().toISOString() };
  const rows = view.rowsHtml([row], { left: refundLeft });
  assert.doesNotMatch(rows, /refund window/, 'no countdown without paidAt');
  assert.match(rows, /NOT COLLECTED/);
  assert.match(view.rowsHtml([{ ...row, payment: 'PAID', paidAt: new Date(Date.now() - 3600000).toISOString() }], { left: refundLeft }), /refund window 23h left/);
});
