import test from 'node:test';
import assert from 'node:assert/strict';
import { applyAction, defaultRefundCents, orderSummary, fulfilmentOf, FULFILMENT } from '../server/lib/order-flow.js';

const NOW = new Date('2026-10-01T12:00:00Z');
const o = { by: 'a@evincus.shop', now: NOW };
const A = 'a|White|S', B = 'b|Black|M';
const mk = (over = {}) => ({
  id: 'o1', status: 'PLACED', paymentStatus: 'PAID', placedAt: 'x', subtotalCents: 10000, taxCents: 1000, feeCents: 300,
  totalCents: 11300, customer: { name: 'Ann', phone: '1' }, email: 'ann@x.com', stockCommitted: true,
  fulfillment: { type: 'pickup', location: { id: 'loc1' } },
  lines: [{ key: A, qty: 2, unitCents: 3000 }, { key: B, qty: 1, unitCents: 4000 }], ...over,
});
const run = (r, a) => applyAction(r, a, o);
const bad = (r, a) => assert.throws(() => run(r, a), { code: 'invalid-action', status: 400 });

test('pickup goes UNFULFILLED → READY → FULFILLED; nothing leaves FULFILLED or CANCELLED', () => {
  assert.deepEqual(FULFILMENT, ['UNFULFILLED', 'READY', 'FULFILLED', 'CANCELLED']);
  const r0 = mk();
  assert.equal(fulfilmentOf(r0), 'UNFULFILLED');
  const r1 = run(r0, { type: 'ready' }).record;
  assert.equal(fulfilmentOf(r1), 'READY');
  assert.equal(fulfilmentOf(r0), 'UNFULFILLED'); // input untouched
  bad(r1, { type: 'ready' });
  const r2 = run(r1, { type: 'fulfilled' }).record;
  for (const a of [{ type: 'ready' }, { type: 'fulfilled' }, { type: 'cancel', restock: true }]) bad(r2, a);
  const c = run(r0, { type: 'cancel', restock: true }).record;
  for (const a of [{ type: 'ready' }, { type: 'fulfilled' }, { type: 'cancel', restock: true }]) bad(c, a);
  assert.deepEqual(r2.events.at(-1), { at: NOW.toISOString(), type: 'fulfilled', by: 'a@evincus.shop' });
  assert.equal(run(r0, { type: 'note', text: 'hi' }).record.events.at(-1).text, 'hi');
});

test('shipping skips READY', () => {
  const s = mk({ fulfillment: { type: 'shipping' } });
  bad(s, { type: 'ready' });
  assert.equal(fulfilmentOf(run(s, { type: 'fulfilled' }).record), 'FULFILLED');
});

test('fulfilled moves on hand and committed down; cancel releases committed; no-restock cancel also lowers on hand', () => {
  assert.deepEqual(run(mk(), { type: 'fulfilled' }).movements, [
    { key: A, onHand: -2, committed: -2, reason: 'sold' }, { key: B, onHand: -1, committed: -1, reason: 'sold' }]);
  assert.deepEqual(run(mk(), { type: 'cancel', restock: true }).movements, [
    { key: A, onHand: 0, committed: -2, reason: 'cancelled' }, { key: B, onHand: 0, committed: -1, reason: 'cancelled' }]);
  assert.deepEqual(run(mk(), { type: 'cancel', restock: false }).movements[0], { key: A, onHand: -2, committed: -2, reason: 'cancelled' });
  bad(mk(), { type: 'cancel' });
});

test('refunds: only on paid orders, never above the total, fee never refunded, status becomes PARTIALLY_REFUNDED then REFUNDED', () => {
  const L = [{ key: A, qty: 2 }];
  bad(mk({ paymentStatus: 'NOT_COLLECTED' }), { type: 'refund', lines: L, amountCents: 100, restock: true, reason: 'x' });
  assert.equal(defaultRefundCents(mk(), L), 6600); // 6000 + 10% tax share 600, no fee
  bad(mk(), { type: 'refund', lines: L, amountCents: 11301, restock: true, reason: 'x' });
  const p = run(mk(), { type: 'refund', lines: L, amountCents: 6600, restock: true, reason: 'x' }).record;
  assert.equal(p.paymentStatus, 'PARTIALLY_REFUNDED');
  assert.equal(p.refundedTaxCents, 600);
  const f = run(p, { type: 'refund', lines: [{ key: B, qty: 1 }], amountCents: 4400, restock: true, reason: 'y' }).record;
  assert.equal(f.paymentStatus, 'REFUNDED');
  assert.equal(f.refundedTaxCents, 1000);
});

test('orders without stockCommitted never produce movements', () => {
  const r = mk({ stockCommitted: undefined });
  assert.deepEqual(run(r, { type: 'fulfilled' }).movements, []);
  assert.deepEqual(run(r, { type: 'cancel', restock: false }).movements, []);
  assert.deepEqual(run(r, { type: 'refund', lines: [{ key: A, qty: 1 }], amountCents: 1, restock: false, reason: 'x' }).movements, []);
});

test('orderSummary has no personal fields and fits in 1 KiB', () => {
  const s = orderSummary(mk());
  assert.deepEqual(Object.keys(s).sort(), ['fulfilment', 'locationId', 'payment', 'placedAt', 'stockCommitted', 'totalCents', 'type', 'units']);
  assert.equal(s.units, 3);
  assert.equal(s.locationId, 'loc1');
  assert.ok(JSON.stringify(s).length < 1024);
  assert.ok(!JSON.stringify(s).includes('ann'));
});

test('partial refund then fulfil moves only the unrefunded qty; unfulfilled refund releases committed', () => {
  const a = { type: 'refund', lines: [{ key: A, qty: 1 }], amountCents: 3300, restock: false, reason: 'x' };
  const r = run(mk(), a);
  assert.deepEqual(r.movements, [{ key: A, onHand: -1, committed: -1, reason: 'refunded' }]);
  assert.deepEqual(run(mk(), { ...a, restock: true }).movements, [{ key: A, onHand: 0, committed: -1, reason: 'refunded' }]);
  assert.deepEqual(run(r.record, { type: 'fulfilled' }).movements, [
    { key: A, onHand: -1, committed: -1, reason: 'sold' }, { key: B, onHand: -1, committed: -1, reason: 'sold' }]);
  const ful = run(mk(), { type: 'fulfilled' }).record;
  assert.deepEqual(run(ful, { ...a, restock: true }).movements, [{ key: A, onHand: 1, committed: 0, reason: 'refunded' }]);
  assert.deepEqual(run(ful, a).movements, []);
});

test('cumulative caps: tax, amount and per-line qty', () => {
  const mkR = (key, qty, amountCents) => ({ type: 'refund', lines: [{ key, qty }], amountCents, restock: true, reason: 'x' });
  const r1 = run(mk(), mkR(A, 2, 6600)).record;
  bad(r1, mkR(A, 1, 100)); // line already fully refunded
  bad(r1, mkR(B, 1, 4401)); // amount beyond the line's items + tax
  // rounding: three 1-cent refunds on 1 cent of tax must not exceed taxCents
  const t = mk({ subtotalCents: 3, taxCents: 1, totalCents: 4, feeCents: 0, lines: [{ key: A, qty: 3, unitCents: 1 }] });
  let rec = t;
  for (let i = 0; i < 3; i++) rec = run(rec, { type: 'refund', lines: [{ key: A, qty: 1 }], amountCents: 1, restock: true, reason: 'x' }).record;
  assert.ok(rec.refundedTaxCents <= 1);
  assert.ok(rec.refundedCents <= 4);
  bad(mk(), { type: 'refund', lines: [], amountCents: 1, restock: true, reason: 'x' });
});

test('cancel after a partial refund releases only the remaining committed units', () => {
  const r = run(mk(), { type: 'refund', lines: [{ key: A, qty: 1 }, { key: B, qty: 1 }], amountCents: 100, restock: false, reason: 'x' }).record;
  assert.deepEqual(run(r, { type: 'cancel', restock: true }).movements, [{ key: A, onHand: 0, committed: -1, reason: 'cancelled' }]);
});

const R = (key, qty, amountCents, over = {}) => ({ type: 'refund', lines: [{ key, qty }], amountCents, restock: true, reason: 'x', ...over });

test('fee is never refunded; refunding items + tax of a one-line order ends REFUNDED', () => {
  const one = mk({ subtotalCents: 10000, lines: [{ key: A, qty: 1, unitCents: 10000 }] });
  bad(one, R(A, 1, 11001)); // above items + tax
  const r = run(one, R(A, 1, 11000)).record;
  assert.equal(r.paymentStatus, 'REFUNDED');
  assert.equal(r.refundedTaxCents, 1000);
  const two = run(mk(), R(A, 2, 6600)).record;
  bad(two, R(B, 1, 4401));
});

test('recorded tax scales with the amount actually refunded and never exceeds it', () => {
  const r = run(mk(), R(A, 1, 1)).record;
  assert.ok(r.refundedTaxCents <= 1);
  assert.equal(r.events.at(-1).taxCents, r.refundedTaxCents);
});

test('final refund takes the last cent of tax', () => {
  const t = mk({ subtotalCents: 3, taxCents: 1, totalCents: 4, feeCents: 0, lines: [{ key: A, qty: 3, unitCents: 1 }] });
  let rec = t;
  for (let i = 0; i < 3; i++) rec = run(rec, R(A, 1, 1)).record;
  assert.equal(rec.refundedTaxCents, 1);
  assert.equal(rec.paymentStatus, 'REFUNDED');
});

test('refunding every line at its default always works and ends REFUNDED with exact tax', () => {
  const cases = [
    mk({ subtotalCents: 3003, taxCents: 452, feeCents: 150, totalCents: 3605,
      lines: ['a', 'b', 'c'].map(k => ({ key: k, qty: 1, unitCents: 1001 })) }),
    mk({ subtotalCents: 2, taxCents: 1, feeCents: 0, totalCents: 3, lines: ['a', 'b'].map(k => ({ key: k, qty: 1, unitCents: 1 })) }),
  ];
  for (const c of cases) {
    let rec = c;
    for (const l of c.lines) {
      const lines = [{ key: l.key, qty: 1 }];
      rec = run(rec, { type: 'refund', lines, amountCents: defaultRefundCents(rec, lines), restock: true, reason: 'x' }).record;
    }
    assert.equal(rec.paymentStatus, 'REFUNDED');
    assert.equal(rec.refundedTaxCents, c.taxCents);
    assert.ok(rec.refundedCents <= c.totalCents - c.feeCents);
  }
});

test('a non-final refund never takes more tax than is left, so 1c lines end REFUNDED only on the last one', () => {
  let rec = mk({ subtotalCents: 4, taxCents: 2, feeCents: 0, totalCents: 6, lines: ['a', 'b', 'c', 'd'].map(k => ({ key: k, qty: 1, unitCents: 1 })) });
  for (const [i, l] of rec.lines.entries()) {
    const lines = [{ key: l.key, qty: 1 }];
    rec = run(rec, { type: 'refund', lines, amountCents: defaultRefundCents(rec, lines), restock: true, reason: 'x' }).record;
    assert.equal(rec.paymentStatus, i === 3 ? 'REFUNDED' : 'PARTIALLY_REFUNDED', `after line ${i + 1}`);
  }
  assert.equal(rec.refundedTaxCents, 2);
  assert.equal(rec.refundedCents, 6);
});

test('the room left caps a refund that is within its line cap', () => {
  // two lines, no tax; after line A (100) is refunded, totalCents is lowered to 150 so only 50 of room is left for B
  const r = mk({ subtotalCents: 200, taxCents: 0, feeCents: 0, totalCents: 250, lines: [{ key: A, qty: 1, unitCents: 100 }, { key: B, qty: 1, unitCents: 100 }] });
  const half = run(r, R(A, 1, 100)).record;
  bad({ ...half, totalCents: 150 }, R(B, 1, 100)); // within line cap (100) but 100 + 100 > 150
  assert.equal(run({ ...half, totalCents: 250 }, R(B, 1, 100)).record.paymentStatus, 'REFUNDED');
});

test('bad input and edge cases', () => {
  const x = mk();
  assert.throws(() => applyAction(x, { type: 'note', text: 'a' }, { by: null }), { code: 'invalid-action' });
  assert.throws(() => applyAction(x, { type: 'note', text: 'a' }, { now: new Date('x') }), { code: 'invalid-action' });
  bad(x, R('zzz|x|y', 1, 1));
  bad(x, R(A, 1.5, 1));
  bad(x, R(A, 1, 1, { restock: 'yes' }));
  bad(x, R(A, 1, 1, { reason: ' ' }));
  bad(x, { type: 'note', text: 'a'.repeat(501) });
  bad(x, { type: 'nope' });
  const d = run(x, { ...R(A, 1, 6600), lines: [{ key: A, qty: 1 }, { key: A, qty: 1 }] });
  assert.deepEqual(d.record.refundedQty, { [A]: 2 });
  bad(x, { ...R(A, 1, 1), lines: [{ key: A, qty: 2 }, { key: A, qty: 1 }] });
  const nt = mk({ taxCents: undefined });
  assert.equal(defaultRefundCents(nt, [{ key: A, qty: 2 }]), 6000);
  assert.equal(run(nt, R(A, 2, 6000)).record.refundedTaxCents, 0);
  const z = mk({ subtotalCents: 0 });
  assert.equal(defaultRefundCents(z, [{ key: A, qty: 1 }]), 3000);
  const rd = run(mk(), { type: 'ready' }).record;
  assert.deepEqual(run(rd, R(A, 1, 3300, { restock: false })).movements, [{ key: A, onHand: -1, committed: -1, reason: 'refunded' }]);
  const c = run(mk(), { type: 'cancel', restock: true }).record;
  assert.deepEqual(run(c, R(A, 1, 3300)).movements, []);
});
