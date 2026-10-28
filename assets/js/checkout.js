import { api, ApiError } from './api.js';
import * as cart from './cart.js';
import { money } from '../../data/catalog.js';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const PENDING_KEY = 'evincus_pending_checkout';
const CARD_ICON = '<svg class="pay-btn__card" viewBox="0 0 28 20" aria-hidden="true"><rect x="1" y="1" width="26" height="18" rx="2"/><path d="M1 7h26M5 14h8"/></svg>';
let pending;
try { pending = JSON.parse(sessionStorage.getItem(PENDING_KEY) ?? 'null'); } catch { pending = null; }
function remember(value) {
  pending = value;
  try { if (value) sessionStorage.setItem(PENDING_KEY, JSON.stringify(value)); else sessionStorage.removeItem(PENDING_KEY); } catch { /* tab memory remains available */ }
}

export async function mountCheckout(container, { q, onPlaced, onBagChanged }) {
  container.innerHTML = '<p class="is-loading" role="status">Loading pickup options…</p>';
  let options;
  try { options = await api('GET', '/api/checkout/options'); }
  catch (err) {
    if (container.isConnected) container.innerHTML = `<p role="alert">${esc(err.message)}</p><button type="button" class="text-btn mono" data-act="back">← Back to cart</button>`;
    return;
  }
  if (!container.isConnected) return;
  const payLabel = `Pay ${money(q.totalCents)}`;
  const input = (name, label, autocomplete, type = 'text', max = 100) => `<label>${label}<input name="${name}" type="${type}" autocomplete="${autocomplete}" maxlength="${max}" required></label>`;
  container.innerHTML = `<form class="checkout-form">
    <p>Your order goes straight through. No payment is collected at checkout.</p>
    <fieldset><legend>Contact details</legend>
      ${input('name', 'Full name', 'name')}${input('email', 'Email', 'email', 'email', 254)}${input('phone', 'Phone (include country code)', 'tel', 'tel', 40)}
    </fieldset>
    <fieldset><legend>In-store pickup · Mandeville</legend>
      <div class="checkout-field"><label for="checkoutPickup">Pickup location</label><select id="checkoutPickup" name="locationId">${options.pickupLocations.map(l => `<option value="${esc(l.id)}">${esc(l.name)} · ${esc(l.area)}</option>`).join('')}</select></div>
      <p class="bag__note" data-pickup-note></p>
    </fieldset>
    <label>Order notes (optional)<textarea name="notes" maxlength="1000" rows="3"></textarea></label>
    <div class="sum"><div class="sum__row sum__total"><span>Order total</span><span data-total></span></div></div>
    <p class="pay-error" role="alert" hidden></p>
    <button type="submit" class="btn btn--solid bag__go pay-btn">${CARD_ICON}<span data-label>${payLabel}</span></button>
    <button type="button" class="text-btn mono" data-act="back">← Back to cart</button>
  </form>`;
  const form = container.querySelector('form');
  const error = form.querySelector('.pay-error');
  const submit = form.querySelector('[type=submit]');
  const label = submit.querySelector('[data-label]');
  const controls = [...form.querySelectorAll('input, select, textarea')];
  const sync = () => {
    const location = options.pickupLocations.find(l => l.id === form.elements.locationId.value);
    form.querySelector('[data-pickup-note]').textContent = location?.address ?? 'We will contact you when your order is ready and confirm the pickup address.';
    form.querySelector('[data-total]').textContent = `${money(q.totalCents)} USD`;
  };
  const lockPending = () => {
    controls.forEach(el => { el.disabled = true; });
    label.textContent = 'Retry payment';
    error.textContent = 'Your last payment could not be confirmed. Retry to recover the same order reference.';
    error.hidden = false;
  };
  if (pending) {
    const values = { ...pending.customer, locationId: pending.fulfillment.locationId, notes: pending.notes };
    for (const [key, value] of Object.entries(values)) if (form.elements[key]) form.elements[key].value = value ?? '';
  }
  sync();
  if (pending) {
    form.querySelector('[data-total]').textContent = `${money(pending.expectedTotalCents)} USD`;
    lockPending();
  }
  form.addEventListener('change', sync);
  form.addEventListener('submit', async e => {
    e.preventDefault();
    if (submit.disabled) return;
    if (!pending) {
      const values = Object.fromEntries(new FormData(form));
      remember({ checkoutToken: crypto.randomUUID(),
        items: cart.rawItems().map(({ id, color, size, qty }) => ({ id, color, size, qty })),
        customer: { name: values.name, email: values.email, phone: values.phone }, notes: values.notes,
        fulfillment: { type: 'pickup', locationId: values.locationId },
        expectedTotalCents: q.totalCents,
      });
    }
    controls.forEach(el => { el.disabled = true; });
    submit.disabled = true;
    label.textContent = 'Processing payment…';
    submit.classList.add('is-busy');
    error.hidden = true;
    try {
      const order = await api('POST', '/api/orders', pending);
      if (typeof order?.id !== 'string' || order.status !== 'PLACED' || order.paymentStatus !== 'NOT_COLLECTED') throw new ApiError(0, null);
      const ordered = pending.items;
      remember(null);
      onPlaced(order, ordered);
    } catch (err) {
      if (err.status >= 400 && err.status < 500 && !['rate-limited', 'checkout-conflict'].includes(err.code)) {
        remember(null);
        controls.forEach(el => { el.disabled = false; });
        sync();
        label.textContent = payLabel;
      } else lockPending();
      submit.classList.remove('is-busy');
      error.textContent = `${err.message}${err.reqId ? ` Reference: ${err.reqId}` : ''}`;
      error.hidden = false;
      submit.disabled = false;
      if (err.code === 'bag-changed') onBagChanged();
    }
  });
}
