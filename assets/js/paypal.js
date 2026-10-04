import { PAYPAL_CLIENT_ID } from './config.js';
import { MAX_QTY } from '../../data/catalog.js';
import * as cart from './cart.js';
import { api, beacon } from './api.js';
import { refreshQuote } from './quote.js';

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

const status = (box, msg) => { box.innerHTML = `<p class="pay-status mono">${msg}</p>`; };
const report = (event, err) => beacon(event, { code: err.code, ...(err.reqId ? { reqId: err.reqId } : {}) });
// The server already logged and alerted these with the order id; a generic beacon would only add noise.
const SERVER_REPORTED = new Set(['capture-unknown', 'capture-mismatch']);

// Renders PayPal's buttons into `container`. Errors show in `errorEl`; `onPaid(order)` runs after a capture.
export async function mountPaypal(container, { errorEl, onPaid }) {
  const showError = msg => { errorEl.textContent = msg; errorEl.hidden = !msg; };

  // Server messages are written for shoppers; a changed bag also refreshes the quote so the bag shows why.
  const showApiError = (event, err) => {
    showError(err.message);
    if (err.code === 'bag-changed') refreshQuote();
    else if (err.status !== 422 && !SERVER_REPORTED.has(err.code)) report(event, err);
  };

  status(container, 'Loading payment options…');
  try {
    await loadSdk();
  } catch {
    beacon('paypal-sdk-failed');
    status(container, 'PayPal could not load. Check your connection and refresh the page.');
    return;
  }
  if (!container.isConnected) return; // the shopper left the pay step while the SDK loaded
  if (!window.paypal) {
    status(container, 'PayPal could not load. Check your connection and refresh the page.');
    return;
  }
  container.innerHTML = '';

  let handled = false;
  let captured = false; // once a capture succeeds in this mount, never tell the shopper they weren't charged
  window.paypal.Buttons({
    style: { layout: 'vertical', color: 'white', shape: 'rect', label: 'checkout', height: 50 },
    // Only ids, options and quantities go to the server; it prices the order and talks to PayPal.
    createOrder: () => {
      handled = false;
      showError('');
      // The bag shows capped lines at the limit, so order exactly what it shows.
      const items = cart.rawItems().map(({ id, color, size, qty }) => ({ id, color, size, qty: Math.min(qty, MAX_QTY) }));
      if (!items.length) return Promise.reject(new Error('empty-bag'));
      return api('POST', '/api/orders', { items }).then(o => o.id, err => {
        handled = true;
        showApiError('order-create-failed', err);
        throw err;
      });
    },
    onApprove: data => api('POST', '/api/orders/capture', { orderID: data.orderID })
      .then(order => {
        captured = true;
        handled = true;
        try {
          onPaid(order);
        } catch (err) {
          console.error('Order confirmation failed', err);
          showError(`Your order is in (reference ${order.id}). We're emailing your receipt.`);
        }
      }, err => {
        handled = true;
        showApiError('capture-failed', err);
      }),
    onCancel: () => showError(''),
    onError: err => {
      if (handled || captured) return;
      if (err?.message === 'empty-bag') { showError('Your bag is empty. Add something before checking out.'); return; }
      console.error('PayPal error', err);
      showError('Payment failed and you were not charged. Try again, or DM @evincus.sw on Instagram.');
    },
  }).render(container).catch(() => { /* container removed before render finished */ });
}
