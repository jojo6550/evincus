// Bag drawer: a native <dialog> with bag, checkout and confirmation steps.
import { money, MAX_QTY } from '../../data/catalog.js';
import * as cart from './cart.js';
import * as quote from './quote.js';
import { mountCheckout } from './checkout.js';

const esc = t => String(t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const STATUS_TEXT = {
  'sold-out': 'Sold out',
  'not-released': 'Not released yet',
  'era-ended': 'No longer sold',
  'unknown-item': 'No longer available',
  'qty-capped': 'Limit of 10 per item',
};
const BUYABLE = new Set(['ok', 'qty-capped', undefined]);
const TITLES = { bag: 'Your bag', pay: 'Check out', paid: 'Order placed' };

let dialog, title, body, foot;
let step = 'bag';

function lineHtml(l) {
  const canChange = BUYABLE.has(l.status);
  return `
    <li class="line${canChange ? '' : ' is-unavailable'}" data-key="${esc(l.key)}">
      <span class="line__img">${l.image ? `<img src="${esc(l.image)}" alt="" loading="lazy">` : ''}</span>
      <div class="line__info">
        <h3 class="line__name">${esc(l.name ?? 'Item no longer available')}</h3>
        <span class="line__meta mono">${esc(l.color)}, size ${esc(l.size)}</span>
        ${STATUS_TEXT[l.status] ? `<span class="line__status mono">${STATUS_TEXT[l.status]}</span>` : ''}
        ${canChange ? `
        <div class="qty" role="group" aria-label="Quantity">
          <button type="button" data-act="dec" aria-label="Remove one">−</button>
          <output aria-live="polite">${l.qty}</output>
          <button type="button" data-act="inc" aria-label="Add one"${l.qty >= MAX_QTY ? ' disabled' : ''}>+</button>
        </div>` : ''}
      </div>
      <div class="line__end">
        ${canChange && l.totalCents !== undefined ? `<span class="price">${money(l.totalCents)}</span>` : ''}
        <button type="button" class="text-btn mono" data-act="remove">Remove</button>
      </div>
    </li>`;
}

const row = (label, value, cls = '') => `<div class="sum__row${cls}"><span>${label}</span><span>${value}</span></div>`;
const checkout = enabled => `<button type="button" class="btn btn--solid bag__go" data-act="checkout"${enabled ? '' : ' disabled'}>Check out</button>`;

function footHtml(s) {
  if (s.status === 'error') {
    return `
      <p class="bag__note" role="status">Prices and availability can't be checked right now, so checkout is paused. Try again in a minute.</p>
      <button type="button" class="btn btn--line bag__go" data-act="retry">Check again</button>`;
  }
  if (s.status !== 'ready' || !s.quote) {
    return `
      ${row('Subtotal', money(cart.subtotal()))}
      <p class="bag__note" role="status">Checking prices and availability…</p>
      ${checkout(false)}`;
  }
  const q = s.quote;
  if (!q.checkoutReady) {
    return `
      <p class="bag__note" role="status">Some items can't be bought. Remove them to check out.</p>
      <button type="button" class="btn btn--line bag__go" data-act="remove-unavailable">Remove unavailable items</button>
      ${row('Subtotal', money(q.subtotalCents))}
      ${checkout(false)}`;
  }
  return `
    ${row('Subtotal', money(q.subtotalCents))}
    ${row('Shipping', q.shippingCents ? money(q.shippingCents) : 'Free')}
    ${row('Total', `${money(q.totalCents)} <small class="mono">USD</small>`, ' sum__total')}
    ${checkout(true)}`;
}

// Re-rendering replaces the buttons; put focus back on the same control so keyboard use isn't interrupted.
function keepFocus(fn) {
  const a = document.activeElement;
  const key = a?.closest?.('.line')?.dataset.key;
  const act = a?.dataset?.act;
  const inFoot = foot.contains(a);
  const inside = dialog.contains(a);
  fn();
  if (!act) return;
  const scope = key ? body.querySelector(`.line[data-key="${CSS.escape(key)}"]`) : inFoot ? foot : null;
  const next = scope?.querySelector(`[data-act="${act}"]:not(:disabled)`)
    ?? scope?.querySelector('[data-act]:not(:disabled)')
    ?? (inside ? title : null);
  next?.focus();
}

function renderBag() {
  title.textContent = TITLES.bag;
  if (!cart.rawItems().length) {
    body.innerHTML = `
      <div class="bag__empty">
        <p>Your bag is empty.</p>
        <a class="btn btn--line" href="#shop" data-act="shop">Shop the drop</a>
      </div>`;
    foot.innerHTML = '';
    foot.hidden = true;
    return;
  }
  const s = quote.current();
  const lines = s.status === 'ready' && s.quote ? s.quote.lines : cart.lines();
  body.innerHTML = `<ul class="lines">${lines.map(lineHtml).join('')}</ul>`;
  foot.innerHTML = footHtml(s);
  foot.hidden = false;
}

function renderPay() {
  const q = quote.current().quote;
  title.textContent = TITLES.pay;
  body.innerHTML = `
    <div class="pay">
      <p class="pay__copy">Refund requests must be sent within 24 hours of purchase. Review our <a href="policies.html#refund" target="_blank" rel="noopener">refund policy</a>, <a href="policies.html#shipping" target="_blank" rel="noopener">shipping policy</a> and <a href="policies.html#terms" target="_blank" rel="noopener">terms</a> before placing your order.</p>
      <div class="checkout-mount"></div>
    </div>`;
  foot.innerHTML = '';
  foot.hidden = true;
  mountCheckout(body.querySelector('.checkout-mount'), { q, onPlaced: onPaid, onBagChanged: () => { go('bag'); quote.refreshQuote(); } });
}

function renderPaid(order) {
  title.textContent = TITLES.paid;
  body.innerHTML = `
    <div class="paid">
      <h3 class="paid__title" tabindex="-1">${order.name ? `Thank you, ${esc(order.name)}.` : 'Thank you.'}</h3>
      <p>Your order is placed. No payment was collected. Your confirmation will be emailed to ${esc(order.email)}.</p>
      <p>${order.fulfillment?.type === 'pickup' ? `Pickup at ${esc(order.fulfillment.location.name)}. We'll contact you when it's ready and confirm the pickup details.` : "We'll contact you with delivery updates."}</p>
      <p class="paid__ref mono">Order reference <b>${esc(order.id)}</b></p>
      <p>Questions? DM <a href="https://www.instagram.com/evincus.sw/" target="_blank" rel="noopener">@evincus.sw</a> on Instagram with your order reference.</p>
      <button type="button" class="btn btn--solid" data-act="keep">Keep shopping</button>
    </div>`;
  foot.innerHTML = '';
  foot.hidden = true;
  body.querySelector('.paid__title').focus();
}

function render() {
  if (step === 'bag') keepFocus(renderBag);
}

function go(next) {
  step = next;
  if (next === 'pay') renderPay();
  else render();
  body.scrollTop = 0;
  if (dialog.open) title.focus();
}

function onPaid(order, ordered) {
  cart.consume(ordered);
  step = 'paid';
  if (!dialog.open) dialog.showModal();
  renderPaid(order);
}

function onQuote() {
  if (step === 'pay') {
    const s = quote.current();
    if (s.status === 'loading') return;
    if (!quote.isCheckoutReady()) { go('bag'); return; }
    const total = body.querySelector('#payTotal');
    if (total) total.textContent = money(s.quote.totalCents);
    return;
  }
  render();
}

function onAction(e) {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const act = btn.dataset.act;
  const key = btn.closest('.line')?.dataset.key;
  if (key) {
    const line = cart.rawItems().find(l => l.key === key);
    if (!line) return;
    if (act === 'inc') cart.setQty(key, line.qty + 1);
    if (act === 'dec') cart.setQty(key, line.qty - 1);
    if (act === 'remove') cart.remove(key);
    return;
  }
  if (act === 'retry') quote.refreshQuote();
  if (act === 'remove-unavailable') cart.removeMany(quote.unavailableKeys());
  if (act === 'checkout' && quote.isCheckoutReady()) go('pay');
  if (act === 'back') go('bag');
  if (act === 'shop' || act === 'keep') closeBag();
}

export function openBag() {
  quote.refreshQuote();
  render();
  if (dialog.open) return;
  // The dialog hands focus back to whatever had it on open; make that the bag button (e.g. when opened from the product view).
  document.getElementById('cart').focus({ preventScroll: true });
  dialog.showModal();
}

export function closeBag() {
  dialog.close();
}

export function initBag() {
  dialog = document.getElementById('bag');
  title = document.getElementById('bagTitle');
  title.tabIndex = -1; // focus target when a step changes
  body = document.getElementById('bagBody');
  foot = document.getElementById('bagFoot');

  document.getElementById('cart').addEventListener('click', openBag);
  document.getElementById('bagClose').addEventListener('click', closeBag);
  body.addEventListener('click', onAction);
  foot.addEventListener('click', onAction);
  dialog.addEventListener('click', e => {
    if (e.target !== dialog) return;
    const r = dialog.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) closeBag();
  });
  // Closing returns to the bag; an uncertain submission remains available for retry.
  dialog.addEventListener('close', () => { if (step !== 'bag') go('bag'); });

  cart.onChange(() => { render(); quote.scheduleQuote(); });
  quote.onQuote(onQuote);
  render();
}
