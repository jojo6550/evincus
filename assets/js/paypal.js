import { PAYPAL_CLIENT_ID } from './config.js';
import * as cart from './cart.js';

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

async function post(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `request-failed-${res.status}`);
  return data;
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
    // Only ids, options and quantities go to the server; it prices the order and talks to PayPal.
    createOrder: () => {
      showError('');
      if (!cart.count()) return Promise.reject(new Error('empty-bag'));
      const items = cart.lines().map(({ id, color, size, qty }) => ({ id, color, size, qty }));
      return post('/api/orders', { items }).then(o => o.id);
    },
    onApprove: data => post('/api/orders/capture', { orderID: data.orderID })
      .then(order => {
        try {
          sessionStorage.setItem('evincus_order', JSON.stringify({
            id: order.id,
            name: order.name,
            email: order.email,
          }));
        } catch { /* confirmation page falls back to generic copy */ }
        cart.clear();
        window.location.hash = '/thank-you';
      })
      .catch(() => showError("Your payment didn't go through and you were not charged. Try again, or DM @evincus.sw on Instagram.")),
    onCancel: () => showError(''),
    onError: err => {
      if (err?.message === 'empty-bag') { showError('Your bag is empty. Add something before checking out.'); return; }
      console.error('PayPal error', err);
      showError('Payment failed and you were not charged. Try again, or DM @evincus.sw on Instagram.');
    },
  }).render(box);
}
