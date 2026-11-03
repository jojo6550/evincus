import test from 'node:test';
import assert from 'node:assert/strict';
import { settleReturn } from '../assets/js/order-page.js';

const ID = 'EV-00000000-0000-4000-8000-000000000001';
const items = [{ id: 'alpha-tee', color: 'Black', size: 'S', qty: 2 }];
const fakeCart = () => { const eaten = []; return { eaten, consume: lines => eaten.push(lines) }; };
const params = (checkout = 'paid', order = ID) => new URLSearchParams({ order, checkout });
const paid = { id: ID, status: 'PLACED', paymentStatus: 'PAID' };

test('a paid return for the pending checkout consumes its items once', () => {
  const cart = fakeCart();
  assert.deepEqual(settleReturn({ params: params(), pending: { orderId: ID, items }, cart, status: paid }), { view: 'paid', consumed: true });
  assert.deepEqual(cart.eaten, [items]);
});

test('a reload after the pending checkout was cleared consumes nothing', () => {
  const cart = fakeCart();
  assert.deepEqual(settleReturn({ params: params(), pending: null, cart, status: paid }), { view: 'paid', consumed: false });
  assert.deepEqual(cart.eaten, []);
});

test('a paid order that is not the pending checkout shows paid and leaves the cart alone', () => {
  const cart = fakeCart();
  assert.deepEqual(settleReturn({ params: params(), pending: { orderId: 'EV-other', items }, cart, status: paid }), { view: 'paid', consumed: false });
  assert.deepEqual(cart.eaten, []);
});

test('the URL is never trusted: checkout=paid on an unpaid order is failed', () => {
  const cart = fakeCart();
  const unpaid = { ...paid, status: 'AWAITING_PAYMENT', paymentStatus: 'UNPAID' };
  assert.deepEqual(settleReturn({ params: params('paid'), pending: { orderId: ID, items }, cart, status: unpaid }), { view: 'failed', consumed: false });
  assert.deepEqual(settleReturn({ params: params('failed'), pending: { orderId: ID, items }, cart, status: { ...paid, id: 'EV-other' } }), { view: 'failed', consumed: false });
  assert.deepEqual(cart.eaten, []);
});
