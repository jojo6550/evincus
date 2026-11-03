// order.html: where WiPay sends the customer back. The server's status, never the URL, says whether it was paid.
export const PENDING_KEY = 'evincus_pending_checkout';

// Paid and this tab's pending checkout is that order: its items leave the cart, once. -> { view, consumed }.
export function settleReturn({ params, pending, cart, status }) {
  const order = params.get('order');
  const paid = status?.paymentStatus === 'PAID' && status.id === order;
  if (!paid) return { view: 'failed', consumed: false };
  if (pending?.orderId !== order) return { view: 'paid', consumed: false };
  cart.consume(pending.items);
  return { view: 'paid', consumed: true };
}

const when = iso => new Intl.DateTimeFormat(undefined, { timeZone: 'America/Jamaica', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));

async function boot(root) {
  const [{ api }, cart] = await Promise.all([import('./api.js'), import('./cart.js')]);
  const params = new URLSearchParams(location.search);
  const $ = id => document.getElementById(id);
  const show = (heading, text) => {
    $('orderTitle').textContent = heading;
    $('orderTitle').classList.remove('is-loading');
    $('orderText').textContent = text;
  };
  const order = params.get('order');
  if (!order) {
    show('Nothing to show', 'This page shows an order after payment. Your cart is still on the store page.');
    $('orderCart').hidden = false;
    return;
  }
  let status;
  try { status = await api('GET', `/api/orders/${encodeURIComponent(order)}/status`); }
  catch (err) {
    show("We couldn't check your payment", `${err.message} Reload this page to try again.`); // the query stays, so a reload checks again
    return;
  }
  let pending = null;
  try { pending = JSON.parse(sessionStorage.getItem(PENDING_KEY) ?? 'null'); } catch { /* storage blocked */ }
  const { view, consumed } = settleReturn({ params, pending, cart, status });
  if (consumed) { try { sessionStorage.removeItem(PENDING_KEY); } catch { /* storage blocked */ } }
  history.replaceState(null, '', location.pathname);
  root.dataset.view = view;
  if (view === 'paid') {
    show('Payment received', 'Your receipt is on its way to the email you entered.');
    $('orderRef').textContent = status.id;
    $('orderTxn').textContent = status.transactionId;
    $('orderPaid').textContent = `${when(status.paidAt)} (Jamaica time)`;
    $('orderStamp').hidden = false;
    $('orderDetails').hidden = false;
    $('orderRefund').hidden = false;
    $('orderShop').hidden = false;
  } else {
    show("Payment didn't go through", 'Nothing was charged for this attempt. Your cart still has your items, so you can pay again.');
    $('orderCart').hidden = false;
  }
}

const root = typeof document !== 'undefined' && document.getElementById('orderPage');
if (root) boot(root);
