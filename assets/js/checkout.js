import { api } from './api.js';
import * as cart from './cart.js';
import { money } from '../../data/catalog.js';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const PENDING_KEY = 'evincus_pending_checkout';
let pending;
try { pending = JSON.parse(sessionStorage.getItem(PENDING_KEY) ?? 'null'); } catch { pending = null; }
function remember(value) {
  pending = value;
  try { if (value) sessionStorage.setItem(PENDING_KEY, JSON.stringify(value)); else sessionStorage.removeItem(PENDING_KEY); } catch { /* tab memory remains available */ }
}

export async function mountCheckout(container, { q, onPlaced, onBagChanged }) {
  container.innerHTML = '<p role="status">Loading delivery and pickup options…</p>';
  let options;
  try { options = await api('GET', '/api/checkout/options'); }
  catch (err) {
    if (container.isConnected) container.innerHTML = `<p role="alert">${esc(err.message)}</p><button type="button" class="text-btn mono" data-act="back">← Back to bag</button>`;
    return;
  }
  if (!container.isConnected) return;
  const regions = new Intl.DisplayNames(['en'], { type: 'region' });
  const countries = options.countries.map(code => ({ code, name: regions.of(code) })).sort((a, b) => a.name.localeCompare(b.name));
  const input = (name, label, autocomplete, type = 'text', max = 100, required = true) => `<label>${label}<input name="${name}" type="${type}" autocomplete="${autocomplete}" maxlength="${max}" ${required ? 'required' : ''}></label>`;
  container.innerHTML = `<form class="checkout-form">
    <p>Your order goes straight through. No payment is collected at checkout.</p>
    <fieldset><legend>Contact details</legend>
      ${input('name', 'Full name', 'name')}${input('email', 'Email', 'email', 'email', 254)}${input('phone', 'Phone (include country code)', 'tel', 'tel', 40)}
    </fieldset>
    <fieldset><legend>Delivery or pickup</legend>
      <div class="checkout-field"><label for="checkoutType">How would you like your order?</label><select id="checkoutType" name="type"><option value="delivery">Worldwide delivery</option><option value="pickup">In-store pickup · Mandeville</option></select></div>
      <div data-delivery>
        <p class="bag__note">Delivery to most countries, including the United States and Canada.</p>
        <div class="checkout-field"><label for="checkoutCountry">Country</label><select id="checkoutCountry" name="country_code" autocomplete="shipping country">${countries.map(c => `<option value="${c.code}"${c.code === 'JM' ? ' selected' : ''}>${esc(c.name)}</option>`).join('')}</select></div>
        ${input('address_line_1', 'Street address', 'shipping address-line1', 'text', 150)}
        ${input('address_line_2', 'Apartment, suite, etc. (optional)', 'shipping address-line2', 'text', 150, false)}
        ${input('admin_area_2', 'City / town', 'shipping address-level2')}
        ${input('admin_area_1', 'State / province / parish', 'shipping address-level1', 'text', 100, false)}
        ${input('postal_code', 'Postal / ZIP code', 'shipping postal-code', 'text', 20, false)}
      </div>
      <div data-pickup hidden><div class="checkout-field"><label for="checkoutPickup">Pickup location</label><select id="checkoutPickup" name="locationId">${options.pickupLocations.map(l => `<option value="${esc(l.id)}">${esc(l.name)} · ${esc(l.area)}</option>`).join('')}</select></div><p class="bag__note" data-pickup-note></p></div>
    </fieldset>
    <label>Order notes (optional)<textarea name="notes" maxlength="1000" rows="3"></textarea></label>
    <div class="sum"><div class="sum__row"><span>Items</span><span>${money(q.subtotalCents)}</span></div><div class="sum__row"><span>Delivery / pickup</span><span data-shipping></span></div><div class="sum__row sum__total"><span>Order total</span><span data-total></span></div></div>
    <p class="pay-error" role="alert" hidden></p>
    <button type="submit" class="btn btn--solid bag__go">Place order</button>
    <button type="button" class="text-btn mono" data-act="back">← Back to bag</button>
  </form>`;
  const form = container.querySelector('form');
  const error = form.querySelector('.pay-error');
  const submit = form.querySelector('[type=submit]');
  const controls = [...form.querySelectorAll('input, select, textarea')];
  const sync = () => {
    const pickup = form.elements.type.value === 'pickup';
    form.querySelector('[data-delivery]').hidden = pickup;
    form.querySelector('[data-pickup]').hidden = !pickup;
    for (const el of form.querySelectorAll('[data-delivery] input, [data-delivery] select')) el.disabled = pickup;
    form.elements.locationId.disabled = !pickup;
    const needsPostal = ['US', 'CA'].includes(form.elements.country_code.value);
    form.elements.admin_area_1.required = !pickup && needsPostal;
    form.elements.postal_code.required = !pickup && needsPostal;
    const location = options.pickupLocations.find(l => l.id === form.elements.locationId.value);
    form.querySelector('[data-pickup-note]').textContent = location?.address ?? 'We will contact you when your order is ready and confirm the pickup address.';
    const shipping = pickup ? 0 : options.deliveryShippingCents;
    form.querySelector('[data-shipping]').textContent = shipping ? money(shipping) : 'Free';
    form.querySelector('[data-total]').textContent = `${money(q.subtotalCents + shipping)} USD`;
  };
  const lockPending = () => {
    controls.forEach(el => { el.disabled = true; });
    submit.textContent = 'Retry order confirmation';
    error.textContent = 'Your last submission could not be confirmed. Retry to recover the same order reference.';
    error.hidden = false;
  };
  if (pending) {
    const values = { ...pending.customer, type: pending.fulfillment.type, ...pending.fulfillment.address, locationId: pending.fulfillment.locationId, notes: pending.notes };
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
      const pickup = values.type === 'pickup';
      remember({ checkoutToken: crypto.randomUUID(),
        items: cart.rawItems().map(({ id, color, size, qty }) => ({ id, color, size, qty })),
        customer: { name: values.name, email: values.email, phone: values.phone }, notes: values.notes,
        fulfillment: pickup ? { type: 'pickup', locationId: values.locationId } : { type: 'delivery', address: Object.fromEntries(['address_line_1', 'address_line_2', 'admin_area_2', 'admin_area_1', 'postal_code', 'country_code'].map(k => [k, values[k]])) },
        expectedTotalCents: q.subtotalCents + (pickup ? 0 : options.deliveryShippingCents),
      });
    }
    controls.forEach(el => { el.disabled = true; });
    submit.disabled = true;
    submit.textContent = 'Placing order…';
    error.hidden = true;
    try {
      const order = await api('POST', '/api/orders', pending);
      const ordered = pending.items;
      remember(null);
      onPlaced(order, ordered);
    } catch (err) {
      if (err.status >= 400 && err.status < 500 && !['rate-limited', 'checkout-conflict'].includes(err.code)) {
        remember(null);
        controls.forEach(el => { el.disabled = false; });
        sync();
        submit.textContent = 'Place order';
      } else lockPending();
      error.textContent = `${err.message}${err.reqId ? ` Reference: ${err.reqId}` : ''}`;
      error.hidden = false;
      submit.disabled = false;
      if (err.code === 'bag-changed') onBagChanged();
    }
  });
}
