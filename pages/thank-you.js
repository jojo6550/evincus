import { esc } from '../assets/js/ui.js';

function readOrder() {
  try { return JSON.parse(sessionStorage.getItem('evincus_order')); } catch { return null; }
}

export const thankYou = {
  render() {
    const o = readOrder();
    if (!o) {
      return /* html */`
<section class="page-head page-empty">
  <div class="wrap">
    <h1 class="display-lg">No order here</h1>
    <p class="block-sub">This page shows your confirmation right after you pay. If you just paid, check your email for PayPal's receipt.</p>
    <a href="#/shop" class="btn btn-light">Back to the shop</a>
  </div>
</section>`;
    }
    return /* html */`
<section class="confirm">
  <div class="flash flash-soft" aria-hidden="true"></div>
  <div class="wrap">
    <h1 class="display-lg">${o.name ? `Thank you, ${esc(o.name)}.` : 'Thank you.'}</h1>
    <p class="block-sub">Your order is in. ${o.email ? `PayPal has sent a receipt to ${esc(o.email)}.` : 'PayPal has emailed you a receipt.'}</p>
    <dl class="confirm-meta">
      <dt>Order reference</dt><dd>${esc(o.id)}</dd>
    </dl>
    <p class="block-sub">Questions about your order? DM <a class="link" href="https://www.instagram.com/evincus.sw/" target="_blank" rel="noopener noreferrer">@evincus.sw</a> with your order reference.</p>
    <a href="#/shop" class="btn btn-light">Keep shopping</a>
  </div>
</section>`;
  },
};
