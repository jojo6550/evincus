import { PAYPAL_CLIENT_ID } from './config.js';
import * as cart from './cart.js';
import { orderTotals } from './totals.js';

const SDK_URL = `https://www.paypal.com/sdk/js?client-id=${PAYPAL_CLIENT_ID}&currency=USD&intent=capture&enable-funding=card&disable-funding=venmo,paylater`;

let sdkPromise = null;

function loadSdk() {
  if (sdkPromise) return sdkPromise;
  sdkPromise = new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = SDK_URL;
    s.dataset.paypalSdk = '';
    s.onload = res;
    s.onerror = () => { sdkPromise = null; s.remove(); rej(new Error('PayPal SDK failed to load')); };
    document.head.appendChild(s);
  });
  return sdkPromise;
}

function showError(msg) {
  const el = document.getElementById('pay-error');
  if (!el) return;
  el.textContent = msg;
  el.hidden = !msg;
}

const usd = n => n.toFixed(2);

function buildOrder() {
  const { lines, subtotal, shipping, total } = orderTotals();
  return {
    purchase_units: [{
      description: 'Evincus order',
      amount: {
        currency_code: 'USD',
        value: usd(total),
        breakdown: {
          item_total: { currency_code: 'USD', value: usd(subtotal) },
          shipping:   { currency_code: 'USD', value: usd(shipping) },
        },
      },
      items: lines.map(l => ({
        name: l.name.slice(0, 127),
        description: `${l.color} / ${l.size}`.slice(0, 127),
        sku: l.key.slice(0, 127),
        quantity: String(l.qty),
        unit_amount: { currency_code: 'USD', value: usd(l.price) },
        category: 'PHYSICAL_GOODS',
      })),
    }],
  };
}

export async function initPaypalButtons() {
  const box = document.getElementById('paypal-buttons');
  if (!box) return;

  box.innerHTML = '<p class="pay-status">Loading payment options…</p>';
  try {
    await loadSdk();
  } catch {
    box.innerHTML = '<p class="pay-status">PayPal could not load. Check your connection and refresh the page.</p>';
    return;
  }
  if (!window.paypal) {
    box.innerHTML = '<p class="pay-status">PayPal is unavailable. The store\'s client ID needs to be set.</p>';
    return;
  }
  if (!document.body.contains(box)) return; // user navigated away while loading
  box.innerHTML = '';

  window.paypal.Buttons({
    style: { layout: 'vertical', color: 'white', shape: 'rect', label: 'checkout', height: 50 },
    createOrder: (data, actions) => {
      showError('');
      if (!cart.count()) return Promise.reject(new Error('empty-bag'));
      return actions.order.create(buildOrder());
    },
    onApprove: (data, actions) => actions.order.capture()
      .then(details => {
        try {
          sessionStorage.setItem('evincus_order', JSON.stringify({
            id: details.id,
            name: details.payer?.name?.given_name ?? '',
            email: details.payer?.email_address ?? '',
          }));
        } catch { /* confirmation page falls back to generic copy */ }
        cart.clear();
        window.location.hash = '/thank-you';
      })
      .catch(() => showError('Your payment didn\'t go through and you were not charged. Try again, or DM @evincus.sw on Instagram.')),
    onCancel: () => showError(''),
    onError: err => {
      if (err?.message === 'empty-bag') { showError('Your bag is empty. Add something before checking out.'); return; }
      console.error('PayPal error', err);
      showError('Payment failed and you were not charged. Try again, or DM @evincus.sw on Instagram.');
    },
  }).render(box);
}
