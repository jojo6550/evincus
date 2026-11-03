// HTML for the Orders tab's list and order page. Every server value goes through esc(): names, notes and
// addresses are typed by customers.
import { esc, thumb } from './inventory-products-view.js';
import { PICKUP_LOCATIONS } from '../../data/fulfillment.js';
import { remaining } from '../../data/refunds.js';

const DAY = 86400000;
export const money = c => `${c < 0 ? '−' : ''}$${(Math.abs(c) / 100).toFixed(2)}`;
const cents = c => (c == null ? '' : (c / 100).toFixed(2));
const tz = { timeZone: 'America/Jamaica' };
const time = new Intl.DateTimeFormat('en-GB', { ...tz, hour: '2-digit', minute: '2-digit' });
const date = new Intl.DateTimeFormat('en-GB', { ...tz, day: 'numeric', month: 'short' });
const jday = ms => new Date(ms - 5 * 3600000).toISOString().slice(0, 10);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const attr = (on, name) => (on ? ` ${name}` : '');

// "today 14:21", "yesterday 18:40", "24 Oct 09:05", in Jamaica time.
export function whenText(iso, now = Date.now()) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const day = jday(t);
  const label = day === jday(now) ? 'today' : day === jday(now - DAY) ? 'yesterday' : date.format(t);
  return `${label} ${time.format(t)}`;
}

const placeOf = (type, locationId) => (type === 'shipping' ? 'Shipping' : `${PICKUP_LOCATIONS.find(l => l.id === locationId)?.name ?? locationId ?? 'Pickup'} pickup`);

const PAY = {
  PAID: ['PAID', 'paid'], NOT_COLLECTED: ['NOT COLLECTED', 'unpaid'], UNPAID: ['AWAITING PAYMENT', 'unpaid'],
  PARTIALLY_REFUNDED: ['PARTLY REFUNDED', 'refund'], REFUNDED: ['REFUNDED', 'refund'],
};
const FUL = { UNFULFILLED: ['UNFULFILLED', 'open'], READY: ['READY FOR PICKUP', 'ready'], CANCELLED: ['CANCELLED', 'done'] };
const badge = ([text, kind]) => `<span class="ob ob--${kind}">${esc(text)}</span>`;
export const badges = (payment, fulfilment, type) => badge(PAY[payment] ?? [payment, 'open'])
  + badge(fulfilment === 'FULFILLED' ? [type === 'shipping' ? 'SHIPPED' : 'PICKED UP', 'done'] : FUL[fulfilment] ?? [fulfilment, 'open']);

// ---- List ----

export const VIEW_LABELS = { open: 'Open', ready: 'Ready', awaiting: 'Awaiting payment', fulfilled: 'Done', cancelled: 'Cancelled', all: 'All' }; // Done: picked up or shipped
const PAYMENT_LABELS = { PAID: 'Paid', NOT_COLLECTED: 'Not collected', UNPAID: 'Awaiting payment', PARTIALLY_REFUNDED: 'Partly refunded', REFUNDED: 'Refunded' };
const options = (map, cur, all) => `<option value="">${all}</option>${Object.entries(map).map(([v, t]) => `<option value="${esc(v)}"${attr(cur === v, 'selected')}>${esc(t)}</option>`).join('')}`;

export function listHtml({ opts, owner, products }) {
  const chip = v => `<button type="button" class="chip" data-view="${v}" aria-pressed="${opts.view === v}">${VIEW_LABELS[v]}</button>`;
  const field = (label, id, input) => `<div class="field"><label for="${id}">${label}</label>${input}</div>`;
  const productMap = Object.fromEntries((products ?? []).map(p => [p.id, p.name || p.id]));
  const filtered = ['from', 'to', 'location', 'payment', 'product'].some(k => opts[k]);
  return `
    <div class="chips" role="group" aria-label="Show">${Object.keys(VIEW_LABELS).map(chip).join('')}</div>
    ${owner ? `<form class="ord__search" role="search">
      <input type="search" name="q" value="${esc(opts.q)}" maxlength="100" placeholder="Search order #, name, phone" aria-label="Search by order number, customer name or phone" autocomplete="off">
      <button type="submit" class="btn btn--line">Search</button>
    </form>` : ''}
    <details class="ord__filters"${attr(filtered, 'open')}>
      <summary class="btn btn--line">Filter</summary>
      <div class="ord__grid">
        ${field('From', 'o-from', `<input id="o-from" name="from" type="date" value="${esc(opts.from)}">`)}
        ${field('To', 'o-to', `<input id="o-to" name="to" type="date" value="${esc(opts.to)}">`)}
        ${field('Pickup', 'o-loc', `<select id="o-loc" name="location">${options(Object.fromEntries(PICKUP_LOCATIONS.map(l => [l.id, l.name])), opts.location, 'Any place')}</select>`)}
        ${field('Payment', 'o-pay', `<select id="o-pay" name="payment">${options(PAYMENT_LABELS, opts.payment, 'Any payment')}</select>`)}
        ${field('Product', 'o-prod', `<select id="o-prod" name="product">${options(productMap, opts.product, products ? 'Any product' : 'Any product (list unavailable)')}</select>`)}
      </div>
      <p class="note">Dates are Jamaica days. Without dates: the last 30 days.</p>
    </details>
    <p class="note ord__status" role="status" aria-live="polite"></p>
    <ul class="olist" aria-label="Orders"></ul>
    <button type="button" class="btn btn--line ord__more" data-act="more" hidden>Load more</button>`;
}

const HEAD = '<li class="olist__head" aria-hidden="true"><span>Order</span><span>Placed</span><span>Where</span><span>Items</span><span>Status</span><span>Total</span></li>';

export function rowsHtml(orders, { now = Date.now(), head = true, left }) {
  return (head ? HEAD : '') + orders.map(o => {
    const timer = left(o.paidAt, now);
    return `<li><a class="orow" href="#orders/${encodeURIComponent(o.id)}">
      <b class="orow__id">${esc(o.id)}${o.name ? ` · ${esc(o.name)}` : ''}</b>
      <span class="orow__total">${money(o.totalCents)}</span>
      <span class="orow__meta"><span>${whenText(o.placedAt, now)}</span><span>${esc(placeOf(o.type, o.locationId))}</span><span>${plural(o.units, 'item')}</span></span>
      <span class="orow__tags">${badges(o.payment, o.fulfilment, o.type)}${timer ? `<small class="ord__timer">refund window ${timer}</small>` : ''}</span>
    </a></li>`;
  }).join('');
}

// ---- Order page ----

const EVENTS = {
  placed: () => 'Order placed', paid: () => 'Paid via WiPay', 'hold-released': () => 'Hold released (unpaid)', ready: () => 'Marked ready for pickup',
  fulfilled: (e, o) => (o.fulfillment?.type === 'shipping' ? 'Shipped' : 'Picked up'),
  cancel: e => `Cancelled · ${e.restock ? 'items back in stock' : 'not put back in stock'}`,
  refund: e => `Refund recorded: ${money(e.amountCents ?? 0)}${e.restock ? ' · back in stock' : ''}${e.reason ? ` · “${e.reason}”` : ''}`,
  note: e => `Note: “${e.text}”`,
};

function linesHtml(pg) {
  const o = pg.order;
  return o.lines.map(l => {
    const src = pg.covers[l.key] ? thumb(pg.covers[l.key]) : '';
    const back = (o.refundedQty?.[l.key] ?? 0);
    return `<li class="oline">
      ${src ? `<img src="/${esc(src)}" alt="" loading="lazy" decoding="async">` : '<span class="oline__img"></span>'}
      <span class="oline__t">${esc(l.name)}<small>${esc(l.color)} / ${esc(l.size)}${l.sku ? ` · ${esc(l.sku)}` : ''}${back ? ` · ${back} refunded` : ''}</small></span>
      <span class="oline__n">${l.qty} × ${money(l.unitCents)}</span>
    </li>`;
  }).join('');
}

function totalsHtml(pg) {
  const o = pg.order, row = (label, c, cls = '') => `<div${cls && ` class="${cls}"`}><span>${label}</span><span>${c}</span></div>`;
  const costed = o.lines.filter(l => Number.isInteger(l.costCents));
  const missing = o.lines.length - costed.length;
  return `<div class="tot">
    ${row('Subtotal', money(o.subtotalCents))}
    ${o.taxCents != null ? row('GCT', money(o.taxCents)) : ''}
    ${o.feeCents != null ? row('Processing fee', money(o.feeCents)) : ''}
    ${row(o.payment ? 'Total charged' : 'Total', `${money(o.totalCents)} USD`, 'tot__g')}
    ${o.refundedCents ? row('Refunded', money(-o.refundedCents), 'tot__m') : ''}
    ${pg.owner && costed.length ? row(`Your cost of goods${missing ? ` (cost missing on ${plural(missing, 'line')})` : ''}`, money(-costed.reduce((s, l) => s + l.costCents * l.qty, 0)), 'tot__m') : ''}
  </div>`;
}

function detailsHtml(pg, left) {
  const o = pg.order, loc = o.fulfillment?.location, pay = o.payment, row = (k, v) => (v ? `<div><span>${k}</span><span>${esc(v)}</span></div>` : '');
  const timer = left(pay?.paidAt);
  const rows = [
    pg.owner && !pg.scrubbed && o.customer && [row('Name', o.customer.name), row('Phone', o.customer.phone), row('Email', o.customer.email), row('Customer notes', o.notes)].join(''),
    row(o.fulfillment?.type === 'shipping' ? 'Delivery' : 'Pickup', o.fulfillment?.type === 'shipping' ? 'Shipping' : loc && `${loc.name}, ${loc.address ?? loc.area}`),
    pg.owner && o.address && row('Ship to', [o.address.line1, o.address.line2, o.address.city, o.address.region, o.address.postalCode, o.address.country].filter(Boolean).join(', ')),
    pay && row('WiPay txn', `${pay.transactionId ?? ''} · paid ${whenText(pay.paidAt)}`),
    timer && row('Refund window', timer),
  ].filter(Boolean).join('');
  return `<section class="card kv"><h2 class="card__title">${pg.owner ? 'Customer · pickup' : 'Pickup'}</h2>
    ${pg.scrubbed ? '<p class="note">Customer details removed after 2 years.</p>' : ''}${rows}</section>`;
}

function timelineHtml(pg) {
  const o = pg.order;
  const items = [...(o.events ?? [])].reverse().map(e => `<li>${esc((EVENTS[e.type] ?? (() => e.type))(e, o))}<small>${whenText(e.at)}${e.by ? ` · ${esc(e.by)}` : ''}</small></li>`);
  return `<section class="card"><h2 class="card__title">Timeline</h2><ul class="tl">${items.join('') || '<li>No events yet.</li>'}</ul>
    ${pg.owner ? `<div class="field"><label for="n-text">Internal note <small>(owners only)</small></label>
      <textarea id="n-text" name="note" rows="2" maxlength="500">${esc(pg.note)}</textarea></div>
      <button type="button" class="btn btn--line" data-act="note-go"${attr(pg.off, 'disabled')}>Add note</button>` : ''}</section>`;
}

function cancelHtml(pg) {
  const paid = ['PAID', 'PARTIALLY_REFUNDED'].includes(pg.order.paymentStatus);
  return `<section class="card ord__panel" aria-labelledby="p-title"><h2 class="card__title" id="p-title">Cancel order</h2>
    <label class="toggle" for="c-restock"><span>Put items back in stock?</span><input id="c-restock" name="restock" type="checkbox"${attr(pg.cancelRestock, 'checked')}></label>
    ${paid ? '<p class="note ord__warn">Refund it in the WiPay dashboard, then record the refund here.</p>' : ''}
    <div class="ord__acts"><button type="button" class="btn ord__danger" data-act="cancel-go"${attr(pg.off, 'disabled')}>Cancel order</button>
    <button type="button" class="btn btn--line" data-act="panel-close">Keep order</button></div></section>`;
}

export const maxText = max => (max == null ? 'pick the items first' : `up to ${money(max)}: the items plus their GCT`);

function refundHtml(pg, max) {
  const o = pg.order, r = pg.refund;
  const lines = o.lines.filter(l => remaining(o, l) > 0).map((l, i) => `<li class="rline">
    <label for="r-q-${i}">${esc(l.name)}<small>${esc(l.color)} / ${esc(l.size)} · ${money(l.unitCents)} each</small></label>
    <input id="r-q-${i}" name="rqty" data-key="${esc(l.key)}" type="number" inputmode="numeric" min="0" max="${remaining(o, l)}" step="1" value="${r.qty[l.key] ?? 0}">
    <small>of ${remaining(o, l)}</small></li>`).join('');
  return `<section class="card ord__panel" aria-labelledby="p-title"><h2 class="card__title" id="p-title">Record refund</h2>
    <p class="note">Refund it in the WiPay dashboard, then record it here. The processing fee is never refunded.</p>
    <ul class="rlines">${lines}</ul>
    <div class="field"><label for="r-amount">Amount (USD) <small id="r-hint">${maxText(max)}</small></label>
      <input id="r-amount" name="ramount" type="number" inputmode="decimal" min="0.01" step="0.01" value="${esc(cents(r.amountCents))}"></div>
    <label class="toggle" for="r-restock"><span>Put the items back in stock?</span><input id="r-restock" name="rrestock" type="checkbox"${attr(r.restock, 'checked')}></label>
    <div class="field"><label for="r-reason">Reason</label><input id="r-reason" name="rreason" maxlength="500" value="${esc(r.reason)}"></div>
    <div class="ord__acts"><button type="button" class="btn" data-act="refund-go"${attr(pg.off, 'disabled')}>Record refund</button>
    <button type="button" class="btn btn--line" data-act="panel-close">Back</button></div></section>`;
}

// `actions` and `labels` from actionsFor/actionLabel; `left(paidAt)` the refund window text; `max` the refund default.
export function pageHtml(pg, { actions, labels, left, max }) {
  const o = pg.order, off = attr(pg.off, 'disabled');
  const lost = pg.lost ? `<div class="pp__conflict" role="alert"><p>${esc(pg.msg)}</p>
    <button type="button" class="btn" data-act="retry"${attr(pg.busy, 'disabled')}>Retry</button>
    <button type="button" class="btn btn--line" data-act="reload"${attr(pg.busy, 'disabled')}>Reload order</button></div>` : '';
  const cls = { ready: 'btn', fulfilled: 'btn', refund: 'btn btn--line', cancel: 'btn btn--line ord__danger' };
  return `
    <a class="pp__back" href="#orders">‹ Orders</a>
    ${lost}
    <div class="ord__head"><h1 class="pp__title">${esc(o.id)}</h1><span class="orow__tags">${badges(o.paymentStatus, o.fulfilmentStatus || 'UNFULFILLED', o.fulfillment?.type || 'pickup')}${o.holdLost ? badge(['Paid after hold expired', 'unpaid']) : ''}</span></div>
    ${o.holdLost && o.stockCommitted !== true ? '<p class="note ord__warn">Payment arrived after the hold expired; restock or refund.</p>' : ''}
    <p class="pp__sub">Placed ${whenText(o.placedAt)}</p>
    ${pg.lost ? '' : `<p class="note ord__msg" role="status" aria-live="polite">${esc(pg.msg)}</p>`}
    ${actions.length ? `<div class="ord__acts">${actions.map(a => `<button type="button" class="${cls[a]}" data-act="${a}"${off}>${esc(labels[a])}</button>`).join('')}</div>` : ''}
    ${pg.panel === 'cancel' ? cancelHtml(pg) : pg.panel === 'refund' ? refundHtml(pg, max) : ''}
    <section class="card"><h2 class="card__title">Items</h2><ul class="olines">${linesHtml(pg)}</ul>${totalsHtml(pg)}</section>
    ${detailsHtml(pg, left)}
    ${timelineHtml(pg)}`;
}
