// Finances tab (owners): where the money went. Numbers from GET /api/inventory/finances; every server string goes
// through esc(). The by-month chart is the Stats tab's chart module.
import { api } from './inventory-api.js';
import { esc } from './inventory-products-view.js';
import { barChart, bucketed, dollars, describe } from './inventory-chart.js';

const PERIODS = [['month', 'This month'], ['last', 'Last month'], ['year', 'Year'], ['custom', 'Custom']];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const minus = cents => `−${dollars(cents)}`;
const plural = (k, word) => `${k} ${word}${k === 1 ? '' : 's'}`;
const monthName = m => `${MONTHS[+m.slice(5, 7) - 1]} ${m.slice(0, 4)}`;
const points = months => months.map(m => ({ day: `${m.month}-01`, cents: m.revenueCents, orders: m.orders ?? 0 }));

// Jamaica day (UTC-5, no DST) as YYYY-MM-DD.
const jamaicaDay = ms => new Date(ms - 5 * 3600000).toISOString().slice(0, 10);
export function periodRange(period, now = Date.now()) {
  const today = jamaicaDay(now), [y, m] = today.split('-').map(Number);
  if (period === 'last') {
    const first = new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 10), end = new Date(Date.UTC(y, m - 1, 0)).toISOString().slice(0, 10);
    return { from: first, to: end };
  }
  if (period === 'year') return { from: `${y}-01-01`, to: today };
  return { from: `${today.slice(0, 8)}01`, to: today };
}

const tile = (label, value, note = '') => `<div class="tile"><small>${label}</small><b>${value}</b>${note ? `<small>${note}</small>` : ''}</div>`;

export function financesHtml(d, { from = '', to = '', table = false } = {}) {
  if (d.empty) return '<p class="empty">No payments collected yet. Order value is in Stats.</p>';
  const margin = `${Math.round(d.marginBps / 100)}%`;
  const csv = `/api/inventory/finances.csv?${new URLSearchParams({ from, to })}`;
  const rows = d.months.map(m => `<tr><td>${esc(monthName(m.month))}</td><td>${dollars(m.revenueCents)}</td><td>${dollars(m.gctOwedCents)}</td><td>${dollars(m.profitCents)}</td></tr>`).join('');
  return `
<div class="tiles fin__tiles">
  ${tile('Revenue (charged)', dollars(d.revenueCents))}
  ${tile('Refunds', minus(d.refundsCents))}
  ${tile('Net revenue', dollars(d.netCents))}
  ${tile('GCT owed', minus(d.gctOwedCents), 'tax you hold, not income')}
  ${tile('WiPay fees', minus(d.feesCents), '4.83% of every charge')}
  ${tile('Cost of goods', minus(d.cogsCents), d.costMissing ? `cost missing on ${plural(d.costMissing, 'item')}` : '')}
  <div class="tile fin__profit"><small>Profit</small><b>${dollars(d.profitCents)}</b><small>${margin} of net revenue</small></div>
</div>
<section class="card"><h3 class="card__title">By month <small>revenue, USD</small></h3>
  <div class="stx__tip" aria-live="polite" role="status"></div>
  <div class="stx__chart"${table ? ' hidden' : ''}>${barChart(points(d.months), { title: 'Revenue per month' })}</div>
  <div class="stx__table"${table ? '' : ' hidden'}><table><thead><tr><th>Month</th><th>Revenue</th><th>GCT owed</th><th>Profit</th></tr></thead><tbody>${rows}</tbody></table></div>
  <button type="button" class="stx__link" data-act="table" aria-pressed="${table}">Table</button>
</section>
<section class="card"><h3 class="card__title">Best sellers <small>by profit</small></h3>
  ${d.bestSellers.length ? `<div class="stx__table"><table><thead><tr><th>Product</th><th>Units</th><th>Revenue</th><th>Profit</th></tr></thead><tbody>${d.bestSellers.map(b => `<tr><td>${esc(b.name)}</td><td>${b.units}</td><td>${dollars(b.revenueCents, true)}</td><td>${dollars(b.profitCents, true)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="empty">Nothing sold in this period.</p>'}
</section>
<section class="card"><h3 class="card__title">Refunds</h3>
  ${d.refunds.length ? `<div class="stx__table"><table><thead><tr><th>Order</th><th>Reason</th><th>Amount</th></tr></thead><tbody>${d.refunds.map(r => `<tr><td>${esc(r.orderId)}</td><td>${esc(r.reason)}</td><td>${dollars(r.amountCents)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="empty">No refunds in this period.</p>'}
</section>
<a class="btn btn--line fin__csv" href="${esc(csv)}" download>Download CSV</a>`;
}

// No fetch: the tab loads `data`, this draws it. Staff never get the tab (the shell hides it, the API is 403).
export function renderFinances(root, data, { owner, ...opts } = {}) {
  root.innerHTML = owner ? financesHtml(data, opts) : '';
}

function render(el) {
  const st = { period: 'month', from: '', to: '', table: false, data: null, error: '', seq: 0 };
  el.innerHTML = '<div class="stx fin"><div class="chips stx__seg" role="group" aria-label="Period"></div><form class="stx__range" hidden><label>From <input type="date" name="from" required></label><label>To <input type="date" name="to" required></label><button class="btn btn--line" type="submit">Apply</button></form><p class="note stx__msg" role="status"></p><div class="stx__body"></div></div>';
  const root = el.firstElementChild;
  const seg = root.querySelector('.stx__seg'), form = root.querySelector('.stx__range'), msg = root.querySelector('.stx__msg'), body = root.querySelector('.stx__body');
  const range = () => (st.period === 'custom' ? { from: st.from, to: st.to } : periodRange(st.period));
  const drawSeg = () => {
    seg.innerHTML = PERIODS.map(([k, label]) => `<button type="button" class="chip" data-period="${k}" aria-pressed="${st.period === k}">${label}</button>`).join('');
    form.hidden = st.period !== 'custom';
  };
  const draw = () => {
    msg.textContent = st.error;
    if (st.data) renderFinances(body, st.data, { owner: true, ...range(), table: st.table });
  };
  async function load() {
    const mine = ++st.seq;
    st.error = st.data ? '' : 'Loading…';
    draw();
    try {
      const data = await api('GET', `/api/inventory/finances?${new URLSearchParams(range())}`);
      if (mine !== st.seq || !root.isConnected) return;
      st.data = data;
      st.error = '';
    } catch (err) {
      if (mine !== st.seq || !root.isConnected) return;
      st.error = err.code === 'invalid-query' ? 'Pick a range of 1 to 366 days, from before to.' : "Couldn't load Finances. Check your connection and pick a period to try again.";
    }
    draw();
  }
  seg.addEventListener('click', e => {
    const k = e.target.closest('[data-period]')?.dataset.period;
    if (!k) return;
    st.period = k;
    drawSeg();
    if (k !== 'custom') load();
  });
  form.addEventListener('submit', e => {
    e.preventDefault();
    st.from = form.elements.from.value;
    st.to = form.elements.to.value;
    load();
  });
  body.addEventListener('click', e => {
    if (e.target.closest('[data-act="table"]')) { st.table = !st.table; draw(); body.querySelector('[data-act="table"]')?.focus(); }
  });
  const show = e => {
    const slot = e.target.closest?.('.slot');
    if (!slot || !st.data) return;
    body.querySelector('.slot.hot')?.classList.remove('hot');
    slot.classList.add('hot');
    body.querySelector('.stx__tip').textContent = describe(bucketed(points(st.data.months))[+slot.dataset.i]);
  };
  const hide = slot => { slot.classList.remove('hot'); body.querySelector('.stx__tip').textContent = ''; };
  body.addEventListener('pointerover', show);
  body.addEventListener('focusin', show);
  body.addEventListener('focusout', e => { const slot = e.target.closest?.('.slot'); if (slot) hide(slot); });
  body.addEventListener('pointerout', e => { const slot = e.target.closest?.('.slot'); if (slot && document.activeElement !== slot) hide(slot); });
  drawSeg();
  return load();
}

// The shell reads the DOM as it loads, so Node tests import this module without it.
if (globalThis.document) {
  import('./inventory.js').then(shell => shell.registerTab('finances', { render }));
}
