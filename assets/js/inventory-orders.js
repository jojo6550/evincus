// Orders tab: the order list (#orders) and one page per order (#orders/<id>).
// The helpers above the UI are pure and exported for tests; nothing here touches the DOM at import.
import { api, newOpId, ApiError } from './inventory-api.js';
import { defaultRefundCents, remaining } from '../../data/refunds.js';
import * as view from './inventory-orders-view.js';

const HOUR = 3600000, WINDOW = 24 * HOUR; // refunds: one day from the purchase (policies.html#refund)
const stateOf = o => o.fulfilmentStatus || 'UNFULFILLED';
const typeOf = o => o.fulfillment?.type || 'pickup';
const charged = o => ['PAID', 'PARTIALLY_REFUNDED'].includes(o.paymentStatus);

// The action buttons an account gets on an order, in order-flow.js's transitions. Owners only.
export function actionsFor(order, role) {
  if (role !== 'owner') return [];
  const s = stateOf(order), pickup = typeOf(order) === 'pickup';
  return [
    pickup && s === 'UNFULFILLED' && 'ready',
    (s === 'UNFULFILLED' || (s === 'READY' && pickup)) && 'fulfilled',
    charged(order) && order.lines.some(l => remaining(order, l) > 0) && 'refund',
    (s === 'UNFULFILLED' || s === 'READY') && 'cancel',
  ].filter(Boolean);
}

export const actionLabel = (order, a) => ({
  ready: 'Mark ready for pickup', fulfilled: typeOf(order) === 'shipping' ? 'Mark shipped' : 'Mark picked up', refund: 'Record refund', cancel: 'Cancel order',
}[a]);

// Time left to ask for a refund, for orders with a payment time (WiPay). -> '21h left', '20m left', or null.
export function refundLeft(paidAt, now = Date.now()) {
  const left = paidAt ? Date.parse(paidAt) + WINDOW - now : NaN;
  if (!(left > 0)) return null;
  return left >= HOUR ? `${Math.floor(left / HOUR)}h left` : `${Math.ceil(left / 60000)}m left`;
}

export function listPath(opts, cursor) {
  const p = new URLSearchParams();
  for (const k of ['view', 'q', 'from', 'to', 'location', 'payment', 'product']) if (opts[k]?.trim()) p.set(k, opts[k].trim());
  if (cursor) p.set('cursor', cursor);
  return `/api/inventory/orders?${p}`;
}

// What to tell the owner, by error code. Anything else shows the server's message.
const ERRORS = {
  'order-changed': 'This order changed since you opened it. It now shows the latest version: check it, then try again.',
  'stock-short': 'There isn’t enough stock on hand for this. Record the stock you received, then try again.',
  'variant-gone': 'That colour or size no longer exists. Refund it without putting it back in stock.',
  'stock-mismatch': 'This order’s stock numbers don’t add up. Check the stock for this product before trying again.',
  'invalid-action': 'That can’t be done to this order now. Reload it to see where it stands.',
  'op-reused': 'That request was already used for something else. Reload the order and try again.',
  'order-busy': 'Someone else changed this order at the same time. Reload it and try again.',
  'unknown-order': 'This order no longer exists.',
  'forbidden': 'Only owners can change orders.',
};
const errorText = err => ERRORS[err.code] ?? err.message;
const DONE = { ready: 'Marked ready for pickup.', fulfilled: 'Done. The units are off On hand.', cancel: 'Order cancelled.', refund: 'Refund recorded.', note: 'Note added.' };
const LOST = 'Couldn’t confirm that the last action went through. Retry it or reload the order.';

// The state of one order page; `d` is the GET reply. Pure, so tests drive its actions without a DOM.
export function newOrderPage({ id, d, who }) {
  return {
    id, order: d.order, version: d.version, covers: d.covers ?? {}, scrubbed: !!d.scrubbed, role: who.role, owner: who.role === 'owner',
    busy: false, lost: null, msg: '', panel: null, cancelRestock: true, refund: { qty: {}, amountCents: null, restock: true, reason: '' }, note: '',
  };
}

// While an action is in flight, or one's reply was lost, no other action goes: it could land on top of the lost one.
export const locked = pg => pg.busy || !!pg.lost;
const unanswered = err => err instanceof ApiError && (err.status === 0 || err.status >= 500);

// One action press. A lost reply (no response, or a 5xx) keeps its opId and version, so Retry resends the same op
// and the server applies it once. Only a reply given after the server's op lookup settles it: 401, 403 and 429 come
// before (requireStaff, the rate limit). -> nothing; the page holds the result.
export async function runAction(pg, action) {
  if (pg.busy) return;
  const key = JSON.stringify(action);
  if (pg.lost && pg.lost.key !== key) { pg.msg = 'Couldn’t confirm the last action. Retry it or reload the order first.'; return; }
  const { opId, version } = pg.lost ?? { opId: newOpId(), version: pg.version };
  Object.assign(pg, { busy: true, msg: '' });
  try {
    const d = await api('POST', `/api/inventory/orders/${encodeURIComponent(pg.id)}/actions`, { version, action }, { opId });
    Object.assign(pg, { order: d.order, version: d.version, lost: null, panel: null, msg: DONE[action.type] ?? 'Saved.' });
    if (action.type === 'note') pg.note = '';
    if (action.type === 'refund') pg.refund = { qty: {}, amountCents: null, restock: true, reason: '' };
  } catch (err) {
    if (unanswered(err)) pg.lost = { key, action, opId, version };
    else if (![401, 403, 429].includes(err.status)) pg.lost = null;
    if (err.code === 'order-changed' && err.details?.current) Object.assign(pg, { order: err.details.current, version: err.details.version, panel: null });
    pg.msg = pg.lost ? LOST : errorText(err);
  } finally {
    pg.busy = false;
  }
}

// Loads the order as stored. That also settles a lost action: whatever it did now shows.
export async function reloadOrder(pg) {
  if (pg.busy) return;
  pg.busy = true;
  try {
    const d = await api('GET', `/api/inventory/orders/${encodeURIComponent(pg.id)}`);
    Object.assign(pg, {
      order: d.order, version: d.version, covers: d.covers ?? {}, scrubbed: !!d.scrubbed, panel: null, lost: null,
      msg: pg.lost ? 'Order reloaded. Check whether the last action went through before trying again.' : '',
    });
  } catch (err) {
    pg.msg = `Couldn’t reload the order: ${err.message}`;
  } finally {
    pg.busy = false;
  }
}

// The refund the panel would send, from its picks. -> { lines, max }: max is the server's default, or null.
const refundPick = pg => {
  const lines = Object.entries(pg.refund.qty).filter(([, q]) => q > 0).map(([key, qty]) => ({ key, qty }));
  return { lines, max: lines.length ? defaultRefundCents(pg.order, lines) : null };
};

// ---- UI ----

let staff = () => null; // the shell's signed-in account, set at registration
const listOpts = { view: 'open', q: '', from: '', to: '', location: '', payment: '', product: '' };
let products = null; // for the product filter, loaded once
let page = null; // the open order page
let listSeq = 0; // only the newest list request draws

const container = (el, cls, text) => {
  const root = document.createElement('div');
  root.className = cls;
  if (text) root.append(Object.assign(document.createElement('p'), { className: 'note', textContent: text }));
  el.replaceChildren(root);
  return root;
};
function failed(root, err, retry) {
  const p = Object.assign(document.createElement('p'), { className: 'note', textContent: err.message });
  const b = Object.assign(document.createElement('button'), { type: 'button', className: 'btn btn--line', textContent: 'Try again' });
  b.addEventListener('click', retry);
  root.replaceChildren(p, b);
}

async function renderList(el) {
  const owner = staff()?.role === 'owner';
  const root = container(el, 'ord', 'Loading…');
  if (!products) products = await api('GET', '/api/inventory/products').then(d => d.products, () => null); // retried next visit
  if (!root.isConnected) return;
  root.innerHTML = view.listHtml({ opts: listOpts, owner, products });
  const rows = root.querySelector('.olist'), more = root.querySelector('.ord__more'), status = root.querySelector('.ord__status');
  let cursor = null;
  const load = async append => {
    const seq = ++listSeq;
    status.textContent = 'Loading…';
    more.disabled = true;
    try {
      const d = await api('GET', listPath(listOpts, append ? cursor : null));
      if (seq !== listSeq || !root.isConnected) return;
      const html = view.rowsHtml(d.orders, { head: !append, left: refundLeft });
      if (append) rows.insertAdjacentHTML('beforeend', html); else rows.innerHTML = html;
      cursor = d.cursor;
      status.textContent = !append && !d.orders.length ? 'No orders match.' : '';
    } catch (err) {
      if (seq === listSeq && root.isConnected) status.textContent = `Couldn’t load the orders: ${err.message}`;
    } finally {
      if (seq === listSeq) { more.hidden = !cursor; more.disabled = false; }
    }
  };
  root.addEventListener('click', e => {
    const chip = e.target.closest('[data-view]');
    if (chip) {
      listOpts.view = chip.dataset.view;
      for (const b of root.querySelectorAll('[data-view]')) b.setAttribute('aria-pressed', String(b === chip));
      return load(false);
    }
    if (e.target.closest('[data-act="more"]')) load(true);
  });
  root.addEventListener('change', e => {
    if (!['from', 'to', 'location', 'payment', 'product'].includes(e.target.name)) return;
    listOpts[e.target.name] = e.target.value;
    load(false);
  });
  root.querySelector('.ord__search')?.addEventListener('submit', e => {
    e.preventDefault();
    listOpts.q = e.target.elements.q.value;
    load(false);
  });
  load(false);
}

async function loadPage(el, id) {
  const root = container(el, 'ord', 'Loading…');
  try {
    const d = await api('GET', `/api/inventory/orders/${encodeURIComponent(id)}`);
    if (!root.isConnected) return;
    page = Object.assign(newOrderPage({ id, d, who: staff() }), { el });
    drawPage();
  } catch (err) {
    if (root.isConnected) failed(root, err, () => loadPage(el, id));
  }
}

function drawPage() {
  const pg = page;
  const focus = document.activeElement?.id;
  const root = container(pg.el, 'ord ord--page');
  const actions = actionsFor(pg.order, pg.role);
  pg.off = locked(pg);
  root.innerHTML = view.pageHtml(pg, {
    actions, labels: Object.fromEntries(actions.map(a => [a, actionLabel(pg.order, a)])), left: paidAt => refundLeft(paidAt), max: refundPick(pg).max,
  });
  root.addEventListener('click', onClick);
  root.addEventListener('input', onInput);
  if (focus) document.getElementById(focus)?.focus({ preventScroll: true });
}

function onInput(e) {
  const t = e.target, pg = page, r = pg.refund;
  if (t.name === 'note') pg.note = t.value;
  else if (t.name === 'restock') pg.cancelRestock = t.checked;
  else if (t.name === 'rrestock') r.restock = t.checked;
  else if (t.name === 'rreason') r.reason = t.value;
  else if (t.name === 'ramount') r.amountCents = t.value === '' ? null : Math.round(Number(t.value) * 100);
  else if (t.name === 'rqty') {
    const n = Number.parseInt(t.value, 10);
    r.qty[t.dataset.key] = Number.isInteger(n) && n > 0 ? n : 0;
    // The default follows the picks. Set in place: a redraw here would swallow a click on Record refund.
    const { max } = refundPick(pg);
    r.amountCents = max;
    pg.el.querySelector('#r-amount').value = max == null ? '' : (max / 100).toFixed(2);
    pg.el.querySelector('#r-hint').textContent = view.maxText(max);
  }
}

// Runs one action with the page's buttons locked, redrawing the page it started on.
async function act(action) {
  const pg = page;
  const done = runAction(pg, action);
  drawPage();
  await done;
  if (page === pg) drawPage();
}

function refundAction(pg) {
  const { lines, max } = refundPick(pg), r = pg.refund;
  const problem = !lines.length ? 'Pick the items to refund.' : max == null ? 'Those quantities can’t be refunded. Reload the order.'
    : !(Number.isInteger(r.amountCents) && r.amountCents > 0 && r.amountCents <= max) ? `Enter an amount from $0.01 to ${view.money(max)}.`
      : !r.reason.trim() ? 'Add a reason.' : '';
  if (problem) { pg.msg = problem; drawPage(); return null; }
  return { type: 'refund', lines, amountCents: r.amountCents, restock: r.restock, reason: r.reason.trim() };
}

function onClick(e) {
  const t = e.target.closest('button[data-act]');
  if (!t) return;
  const pg = page, a = t.dataset.act;
  if (a === 'ready' || a === 'fulfilled') return act({ type: a });
  if (a === 'cancel' || a === 'refund') { Object.assign(pg, { panel: a, msg: '' }); return drawPage(); }
  if (a === 'panel-close') { Object.assign(pg, { panel: null, msg: '' }); return drawPage(); }
  if (a === 'cancel-go') return act({ type: 'cancel', restock: pg.cancelRestock });
  if (a === 'refund-go') { const action = refundAction(pg); return action && act(action); }
  if (a === 'note-go') {
    if (!pg.note.trim()) { pg.msg = 'Write the note first.'; return drawPage(); }
    return act({ type: 'note', text: pg.note.trim() });
  }
  if (a === 'retry' && pg.lost) return act(pg.lost.action);
  if (a === 'reload') return (async () => { const done = reloadOrder(pg); drawPage(); await done; if (page === pg) drawPage(); })();
}

function render(el, [id]) {
  page = null;
  return id ? loadPage(el, id) : renderList(el);
}

// Leaving with an action unconfirmed loses nothing: reopening the order shows what landed.
const canLeave = () => !page?.busy || confirm('An order action is still saving. Leave anyway?');

// The shell reads the DOM as it loads, so Node tests import this module without it.
if (globalThis.document) {
  import('./inventory.js').then(shell => {
    staff = shell.staff;
    shell.registerTab('orders', { render, canLeave });
  });
}
