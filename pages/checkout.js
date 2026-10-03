import { money } from '../data/products.js';
import { esc } from '../assets/js/ui.js';
import * as cart from '../assets/js/cart.js';
import { orderTotals } from '../assets/js/totals.js';
import { initPaypalButtons } from '../assets/js/paypal.js';
import { openBag } from '../assets/js/app.js';

function summary() {
  const { lines, subtotal, shipping, total } = orderTotals();
  return `
    <ul class="summary-lines" role="list">
      ${lines.map(l => `
        <li class="summary-line">
          <span class="summary-img"><img src="${l.image}" alt=""><span class="summary-qty">${l.qty}</span></span>
          <span class="summary-text">
            <span class="line-name">${esc(l.name)}</span>
            <span class="line-meta">${esc(l.color)}, size ${esc(l.size)}</span>
          </span>
          <span>${money(l.total)}</span>
        </li>`).join('')}
    </ul>
    <div class="sum-row"><span>Subtotal</span><span>${money(subtotal)}</span></div>
    <div class="sum-row"><span>Shipping</span><span>${shipping ? money(shipping) : 'Free'}</span></div>
    <div class="sum-row sum-total"><span>Total</span><span>${money(total)} <small>USD</small></span></div>`;
}

let watching = false;

export const checkout = {
  render() {
    if (!cart.count()) {
      return /* html */`
<section class="page-head page-empty">
  <div class="wrap">
    <h1 class="display-lg">Checkout</h1>
    <p class="block-sub">Your bag is empty. Add a piece from the shop, then come back here to pay.</p>
    <a href="#/shop" class="btn btn-light">Shop the collection</a>
  </div>
</section>`;
    }

    return /* html */`
<section class="page-head">
  <div class="wrap"><h1 class="display-lg">Checkout</h1></div>
</section>

<section class="block block-tight">
  <div class="wrap checkout-grid">
    <div class="panel">
      <div class="panel-head">
        <h2 class="panel-title">Order summary</h2>
        <button type="button" class="text-btn" id="editBag">Edit bag</button>
      </div>
      <div id="summary">${summary()}</div>
    </div>

    <div class="panel panel-pay">
      <h2 class="panel-title">Pay</h2>
      <p class="pay-copy">Pay with your PayPal account, or choose debit or credit card to pay without one. You'll confirm your shipping address with PayPal before the payment goes through.</p>
      <p class="pay-error" id="pay-error" role="alert" hidden></p>
      <div id="paypal-buttons" class="paypal-box"></div>
      <p class="pay-fine">Evincus never sees or stores your card details.</p>
    </div>
  </div>
</section>`;
  },

  init() {
    if (!cart.count()) return;
    document.getElementById('editBag').addEventListener('click', openBag);
    initPaypalButtons();

    if (!watching) {
      watching = true;
      cart.onChange(() => {
        const el = document.getElementById('summary');
        if (!el) return;
        if (!cart.count()) { window.dispatchEvent(new HashChangeEvent('hashchange')); return; }
        el.innerHTML = summary();
      });
    }
  },
};
