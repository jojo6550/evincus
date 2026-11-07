import { api, ApiError } from './api.js';
import * as cart from './cart.js';
import { money } from '../../data/catalog.js';
import { COUNTRIES } from '../../data/countries.js';
import { formatPrice, currentCurrency } from './currency.js';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const CARD_ICON = '<svg class="pay-btn__card" viewBox="0 0 28 20" aria-hidden="true"><rect x="1" y="1" width="26" height="18" rx="2"/><path d="M1 7h26M5 14h8"/></svg>';
const PENDING_KEY = 'evincus_pending_checkout'; // order.html (order-page.js) reads it too
const ADDRESS = ['line1', 'line2', 'city', 'region', 'postalCode', 'country'];
let pending;
try { pending = JSON.parse(sessionStorage.getItem(PENDING_KEY) ?? 'null'); } catch { pending = null; }
function remember(value) {
  pending = value;
  try { if (value) sessionStorage.setItem(PENDING_KEY, JSON.stringify(value)); else sessionStorage.removeItem(PENDING_KEY); } catch { /* tab memory remains available */ }
}

let countryOptions;
const countries = () => {
  if (countryOptions) return countryOptions;
  let names;
  try { names = new Intl.DisplayNames(undefined, { type: 'region' }); } catch { names = null; }
  countryOptions = Object.keys(COUNTRIES).map(code => [code, names?.of(code) ?? code]).sort((a, b) => a[1].localeCompare(b[1]))
    .map(([code, name]) => `<option value="${code}">${esc(name)}</option>`).join('');
  return countryOptions;
};

// `breakdown(q)` renders the cart's money rows, so checkout repeats exactly what the bag showed.
export async function mountCheckout(container, { q, breakdown, onBagChanged }) {
  container.innerHTML = '<p class="is-loading" role="status">Loading pickup options…</p>';
  let options;
  try { options = await api('GET', '/api/checkout/options'); }
  catch (err) {
    if (container.isConnected) container.innerHTML = `<p role="alert">${esc(err.message)}</p><button type="button" class="text-btn mono" data-act="back">← Back to cart</button>`;
    return;
  }
  if (!container.isConnected) return;
  const total = pending?.expectedTotalCents ?? q.totalCents;
  const payLabel = `Pay ${money(total)} USD`;
  const input = (name, label, autocomplete, { type = 'text', max = 100, required = true } = {}) =>
    `<label>${label}<input name="${name}" type="${type}" autocomplete="${autocomplete}" maxlength="${max}"${required ? ' required' : ''}></label>`;
  container.innerHTML = `<form class="checkout-form">
    <fieldset><legend>Contact details</legend>
      ${input('firstName', 'First name', 'given-name', { max: 30 })}${input('lastName', 'Last name', 'family-name', { max: 30 })}
      ${input('email', 'Email (50 characters max)', 'email', { type: 'email', max: 50 })}
      ${input('phone', 'Phone, optional (include country code)', 'tel', { type: 'tel', max: 40, required: false })}
    </fieldset>
    <fieldset><legend>Pickup or shipping</legend>
      <label class="checkout-choice"><input type="radio" name="fulfillment" value="pickup" checked> In-store pickup · Mandeville</label>
      <label class="checkout-choice"><input type="radio" name="fulfillment" value="shipping"> Shipping</label>
      <div class="checkout-field" data-pickup><label for="checkoutPickup">Pickup location</label><select id="checkoutPickup" name="locationId">${options.pickupLocations.map(l => `<option value="${esc(l.id)}">${esc(l.name)} · ${esc(l.area)}</option>`).join('')}</select>
        <p class="bag__note" data-pickup-note></p></div>
      <div class="checkout-address" data-address hidden>
        ${input('line1', 'Address', 'address-line1')}${input('line2', 'Apartment, suite, etc. (optional)', 'address-line2', { required: false })}
        ${input('city', 'City or town', 'address-level2', { max: 60 })}${input('region', 'State, province or parish (optional)', 'address-level1', { max: 60, required: false })}
        ${input('postalCode', 'Postal code (optional)', 'postal-code', { max: 20, required: false })}
        <div class="checkout-field"><label for="checkoutCountry">Country</label><select id="checkoutCountry" name="country" autocomplete="country" required><option value="">Choose a country</option>${countries()}</select></div>
        <p class="bag__note">We'll contact you about shipping cost and timing after you pay.</p>
      </div>
    </fieldset>
    <label>Order notes (optional)<textarea name="notes" maxlength="1000" rows="3"></textarea></label>
    <div class="sum">
      <ul class="sum__items">${q.lines.map(l => `<li class="sum__row"><span>${esc(l.name)} × ${l.qty}<small>${esc(l.color)}, size ${esc(l.size)}</small></span><span>${formatPrice(l.totalCents)}</span></li>`).join('')}</ul>
      ${breakdown(q)}
    </div>
    <p class="bag__note">You'll be charged ${money(total)} USD${currentCurrency() === 'USD' ? '' : ` (${formatPrice(total)})`}. Other currencies are estimates; your bank sets the final rate.</p>
    <p class="pay-error" role="alert" hidden></p>
    <button type="submit" class="btn btn--solid bag__go pay-btn">${CARD_ICON}<span data-label>${payLabel}</span></button>
    <button type="button" class="text-btn mono" data-act="back">← Back to cart</button>
  </form>`;
  const form = container.querySelector('form');
  const error = form.querySelector('.pay-error');
  const submit = form.querySelector('[type=submit]');
  const label = submit.querySelector('[data-label]');
  const controls = [...form.querySelectorAll('input, select, textarea')];
  const shipping = () => form.elements.fulfillment.value === 'shipping';
  // Hidden fields are disabled too, so the browser neither validates nor submits them.
  const sync = () => {
    const ship = shipping();
    form.querySelector('[data-address]').hidden = !ship;
    form.querySelector('[data-pickup]').hidden = ship;
    for (const name of ADDRESS) form.elements[name].disabled = !ship;
    form.elements.locationId.disabled = ship;
    const location = options.pickupLocations.find(l => l.id === form.elements.locationId.value);
    form.querySelector('[data-pickup-note]').textContent = location?.address ?? 'We will contact you when your order is ready and confirm the pickup address.';
  };
  const lockPending = message => {
    controls.forEach(el => { el.disabled = true; });
    label.textContent = 'Pay again';
    error.textContent = message;
    error.hidden = false;
  };
  if (pending) {
    const f = pending.fulfillment;
    const values = { ...pending.customer, fulfillment: f.type, locationId: f.locationId, ...f.address, notes: pending.notes };
    for (const [key, value] of Object.entries(values)) if (form.elements[key]) form.elements[key].value = value ?? '';
  }
  sync();
  if (pending) lockPending(pending.orderId ? "Your payment didn't go through. Pay again for the same order." : 'Your last order could not be confirmed. Pay again to recover the same order reference.');
  form.addEventListener('change', sync);
  form.addEventListener('submit', async e => {
    e.preventDefault();
    if (submit.disabled) return;
    if (!pending) {
      const v = Object.fromEntries(new FormData(form));
      remember({ checkoutToken: crypto.randomUUID(),
        items: cart.rawItems().map(({ id, color, size, qty }) => ({ id, color, size, qty })),
        customer: { firstName: v.firstName, lastName: v.lastName, email: v.email, ...(v.phone.trim() && { phone: v.phone }) }, notes: v.notes,
        fulfillment: v.fulfillment === 'shipping'
          ? { type: 'shipping', address: Object.fromEntries(ADDRESS.map(k => [k, v[k] ?? ''])) }
          : { type: 'pickup', locationId: v.locationId },
        expectedTotalCents: q.totalCents,
      });
    }
    controls.forEach(el => { el.disabled = true; });
    submit.disabled = true;
    label.textContent = 'Starting payment…';
    submit.classList.add('is-busy');
    error.hidden = true;
    let placed = !!pending.orderId;
    try {
      const order = await api('POST', '/api/orders', pending);
      if (typeof order?.id !== 'string') throw new ApiError(0, null);
      remember({ ...pending, orderId: order.id });
      placed = true;
      const payment = await api('POST', `/api/orders/${encodeURIComponent(order.id)}/pay`, {});
      if (payment?.paid) location.assign(`/order.html?order=${encodeURIComponent(order.id)}`);
      else if (typeof payment?.url === 'string') location.assign(payment.url);
      else throw new ApiError(0, null);
    } catch (err) {
      // Before an order exists, a refused form can be fixed and resent as a new one. After, it stays this order.
      // hold-expired: that order can't be paid any more, so the next submit starts a new one (stock checked again).
      if (err.code === 'hold-expired' || (!placed && err.status >= 400 && err.status < 500 && !['rate-limited', 'checkout-conflict'].includes(err.code))) {
        remember(null);
        controls.forEach(el => { el.disabled = false; });
        sync();
        label.textContent = payLabel;
      } else lockPending(err.message);
      submit.classList.remove('is-busy');
      error.textContent = `${err.message}${err.reqId ? ` Reference: ${err.reqId}` : ''}`;
      error.hidden = false;
      submit.disabled = false;
      if (err.code === 'bag-changed') onBagChanged();
    }
  });
}
