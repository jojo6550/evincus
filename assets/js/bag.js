// Bag drawer: a native <dialog> with bag and checkout steps. Payment confirmation is order.html, after WiPay.
import { money, MAX_QTY } from '../../data/catalog.js';
import * as cart from './cart.js';
import * as quote from './quote.js';
import { mountCheckout } from './checkout.js';
import { imageAttrs } from './images.js';
import { formatPrice, currentCurrency, onCurrencyChange } from './currency.js';

const esc = t => String(t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const STATUS_TEXT = {
  'sold-out': 'Sold out',
  'not-released': 'Not released yet',
  'era-ended': 'No longer sold',
  'unknown-item': 'No longer available',
  'qty-capped': 'Limit of 10 per item',
  'insufficient-stock': l => `Only ${esc(l.available)} left`,
};
const BUYABLE = new Set(['ok', 'qty-capped', 'insufficient-stock', undefined]);
const TITLES = { bag: 'Your cart', pay: 'Check out' };

let dialog, title, body, foot;
let step = 'bag';

function lineHtml(l) {
  const canChange = BUYABLE.has(l.status);
  const text = STATUS_TEXT[l.status];
  const status = typeof text === 'function' ? text(l) : text;
  return `
    <li class="line${canChange ? '' : ' is-unavailable'}" data-key="${esc(l.key)}">
      <span class="line__img">${l.image ? `<img ${imageAttrs(l.image, '96px')} alt="" loading="lazy">` : ''}</span>
      <div class="line__info">
        <h3 class="line__name">${esc(l.name ?? 'Item no longer available')}</h3>
        <span class="line__meta mono">${esc(l.color)}, size ${esc(l.size)}</span>
        ${status ? `<span class="line__status mono">${status}</span>` : ''}
        ${canChange ? `
        <div class="qty" role="group" aria-label="Quantity">
          <button type="button" data-act="dec" aria-label="Remove one">−</button>
          <output aria-live="polite">${l.qty}</output>
          <button type="button" data-act="inc" aria-label="Add one"${l.qty >= MAX_QTY ? ' disabled' : ''}>+</button>
        </div>` : ''}
      </div>
      <div class="line__end">
        ${canChange && l.totalCents !== undefined ? `<span class="price">${formatPrice(l.totalCents)}</span>` : ''}
        <button type="button" class="text-btn mono" data-act="remove">Remove</button>
      </div>
    </li>`;
}

const row = (label, value, cls = '') => `<div class="sum__row${cls}"><span>${label}</span><span>${value}</span></div>`;
const pct = bps => `${bps / 100}%`;
// Rates come from the quote, so a rate change in data/fees.js needs no client edit. The total is always the USD
// amount WiPay charges; other rows follow the chosen currency.
export const breakdownHtml = q => `
    ${row('Subtotal', formatPrice(q.subtotalCents))}
    ${row(`${esc(q.tax.label)} (${pct(q.tax.bps)})`, formatPrice(q.taxCents))}
    ${row(`${esc(q.fee.label)} (${pct(q.fee.bps)}, non-refundable)`, formatPrice(q.feeCents))}
    ${row('Total', `${money(q.totalCents)} <small class="mono">USD</small>`, ' sum__total')}
    ${currentCurrency() === 'USD' ? '' : `<p class="sum__est mono">${formatPrice(q.totalCents)}. Your bank sets the final rate.</p>`}`;
const checkout = enabled => `<button type="button" class="btn btn--solid bag__go" data-act="checkout"${enabled ? '' : ' disabled'}>Check out</button>`;

function footHtml(s) {
  if (s.status === 'error') {
    return `
      <p class="bag__note" role="status">Prices and availability can't be checked right now, so checkout is paused. Try again in a minute.</p>
      <button type="button" class="btn btn--line bag__go" data-act="retry">Check again</button>`;
  }
  if (s.status !== 'ready' || !s.quote) {
    return `
      ${row('Subtotal', formatPrice(cart.subtotal()))}
      <p class="bag__note is-loading" role="status">Checking prices and availability…</p>
      ${checkout(false)}`;
  }
  const q = s.quote;
  if (!q.checkoutReady) {
    const unavailable = quote.unavailableKeys().length > 0;
    return `
      <p class="bag__note" role="status">${q.problem ? esc(q.message) : `Some items can't be bought. ${unavailable ? 'Remove them' : 'Lower the quantity'} to check out.`}</p>
      ${unavailable ? '<button type="button" class="btn btn--line bag__go" data-act="remove-unavailable">Remove unavailable items</button>' : ''}
      ${row('Subtotal', formatPrice(q.subtotalCents))}
      ${checkout(false)}`;
  }
  return `
    ${breakdownHtml(q)}
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
        <p>Your cart is empty.</p>
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
      <p class="pay__copy">You'll pay by card on WiPay's secure page. Refund requests must be sent within 24 hours of purchase. Review our <a href="/policies.html#refund" target="_blank" rel="noopener">refund policy</a>, <a href="/policies.html#pickup" target="_blank" rel="noopener">pickup</a> and <a href="/policies.html#shipping" target="_blank" rel="noopener">shipping</a> policies and <a href="/policies.html#terms" target="_blank" rel="noopener">terms</a> before you pay.</p>
      <div class="checkout-mount"></div>
    </div>`;
  foot.innerHTML = '';
  foot.hidden = true;
  mountCheckout(body.querySelector('.checkout-mount'), { q, breakdown: breakdownHtml, onBagChanged: () => { go('bag'); quote.refreshQuote(); } });
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
  if (act === 'shop') closeBag();
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
  onCurrencyChange(render);
  quote.onQuote(onQuote);
  render();
}
