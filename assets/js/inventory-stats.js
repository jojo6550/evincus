// Stats tab: how the store is moving. Numbers come from GET /api/inventory/stats; every server string goes through esc().
import { api } from './inventory-api.js';
import { esc } from './inventory-products-view.js';
import { barChart, bucketed, dollars, describe } from './inventory-chart.js';
import { PICKUP_LOCATIONS } from '../../data/fulfillment.js';

const PERIODS = [['today', 'Today'], ['7d', '7 days'], ['30d', '30 days'], ['custom', 'Custom']];
const LISTS = [['product', 'Product'], ['era', 'Era'], ['colour', 'Colour']];
const VS = { today: 'yesterday', '7d': 'prev 7 days', '30d': 'prev 30 days', custom: 'prev period' };
const plural = (k, word) => `${k} ${word}${k === 1 ? '' : 's'}`;

// "▲ 18%" and the words "up"/"down" for assistive tech; "new" when there was nothing before.
export function delta(cur, prev, { absolute = false } = {}) {
  if (cur === prev) return { cls: 'flat', text: 'no change', icon: '–', short: 'same' };
  if (!prev && !absolute) return { cls: 'up', text: 'up from nothing', icon: '▲', short: 'new' };
  const up = cur > prev, diff = absolute ? Math.abs(cur - prev) : `${Math.round(Math.abs(cur - prev) / prev * 100)}%`;
  return { cls: up ? 'up' : 'down', text: `${up ? 'up' : 'down'} ${diff}`, icon: up ? '▲' : '▼', short: diff };
}

function tile(label, value, d, vs) {
  return `<div class="tile"><small>${label}</small><b>${value}</b><span class="delta delta--${d.cls}"><i aria-hidden="true">${d.icon} ${esc(d.short ?? '')}</i><span class="sr">${esc(d.text)}</span> vs ${esc(vs)}</span></div>`;
}

function rankHtml(list) {
  if (!list.length) return '<p class="empty">Nothing sold in this period.</p>';
  const max = list[0].units;
  return `<ol class="rank">${list.map(r => `<li><span>${esc(r.name)}</span><em>${r.units}</em><progress max="${max}" value="${r.units}" aria-hidden="true"></progress></li>`).join('')}</ol>`;
}

const locationName = id => PICKUP_LOCATIONS.find(l => l.id === id)?.name ?? 'Other';

export function statsHtml(d, { list = 'product', table = false, vs = 'prev period' } = {}) {
  const t = d.tiles, p = t.prev;
  const rows = bucketed(d.perDay).map(r => `<tr><td>${esc(r.label)}</td><td>${dollars(r.cents)}</td><td>${r.orders}</td></tr>`).join('');
  const orders = t.orders;
  return `
<div class="tiles stx__tiles">
  ${tile('Sales (order value)', dollars(t.sales), delta(t.sales, p.sales), vs)}
  ${tile('Orders', orders, delta(orders, p.orders, { absolute: true }), vs)}
  ${tile('Units sold', t.units, delta(t.units, p.units), vs)}
  ${tile('Avg order', dollars(t.average), delta(t.average, p.average), vs)}
</div>
<section class="card"><h3 class="card__title">Sales per day <small>USD, order value</small></h3>
  <div class="stx__tip" aria-live="polite" role="status"></div>
  <div class="stx__chart"${table ? ' hidden' : ''}>${barChart(d.perDay)}</div>
  <div class="stx__table"${table ? '' : ' hidden'}><table><thead><tr><th>Period</th><th>Sales</th><th>Orders</th></tr></thead><tbody>${rows}</tbody></table></div>
  <button type="button" class="stx__link" data-act="table" aria-pressed="${table}">Table</button>
</section>
<section class="card"><h3 class="card__title">Best sellers <small>units</small></h3>
  <div class="chips">${LISTS.map(([k, label]) => `<button type="button" class="chip" data-list="${k}" aria-pressed="${list === k}">${label}</button>`).join('')}</div>
  ${rankHtml(d.best[list])}
</section>
<section class="card"><h3 class="card__title">Sizes sold</h3>
  ${d.sizes.length ? `<div class="stx__mini">${d.sizes.map(s => `<div><small>${esc(s.name)}</small>${s.units}</div>`).join('')}</div>` : '<p class="empty">Nothing sold in this period.</p>'}
  ${d.pickup.length ? `<h3 class="card__title">Pickup split</h3><div class="stx__mini">${d.pickup.map(l => `<div><small>${esc(locationName(l.locationId))}</small>${Math.round(l.orders / orders * 100)}% <small>${plural(l.orders, 'order')}</small></div>`).join('')}</div>` : ''}
</section>
<section class="card"><h3 class="card__title">Running low</h3>
  ${d.low.length ? `<ul class="stx__low">${d.low.map(v => `<li><span>${esc(v.name)} · ${esc(v.color)} / ${esc(v.size)}</span>${v.out
    ? '<b class="stx__out"><i aria-hidden="true">✕</i> Out</b>'
    : `<b class="stx__few"><i aria-hidden="true">!</i> ${v.available} left</b>`}</li>`).join('')}</ul>` : '<p class="empty">Nothing is running low.</p>'}
</section>`;
}

function render(el) {
  const st = { period: '30d', from: '', to: '', list: 'product', table: false, data: null, error: '', seq: 0 };
  el.innerHTML = '<div class="stx"><div class="chips stx__seg" role="group" aria-label="Period"></div><form class="stx__range" hidden><label>From <input type="date" name="from" required></label><label>To <input type="date" name="to" required></label><button class="btn btn--line" type="submit">Apply</button></form><p class="note stx__msg" role="status"></p><div class="stx__body"></div></div>';
  const root = el.firstElementChild;
  const seg = root.querySelector('.stx__seg'), form = root.querySelector('.stx__range'), msg = root.querySelector('.stx__msg'), body = root.querySelector('.stx__body');

  const drawSeg = () => {
    seg.innerHTML = PERIODS.map(([k, label]) => `<button type="button" class="chip" data-period="${k}" aria-pressed="${st.period === k}">${label}</button>`).join('');
    form.hidden = st.period !== 'custom';
  };
  const draw = () => {
    msg.textContent = st.error;
    if (st.data) body.innerHTML = statsHtml(st.data, { list: st.list, table: st.table, vs: VS[st.period] });
  };
  async function load() {
    const mine = ++st.seq;
    st.error = st.data ? '' : 'Loading…';
    draw();
    const q = new URLSearchParams({ period: st.period, ...(st.period === 'custom' && { from: st.from, to: st.to }) });
    try {
      const data = await api('GET', `/api/inventory/stats?${q}`);
      if (mine !== st.seq || !root.isConnected) return;
      st.data = data;
      st.error = '';
    } catch (err) {
      if (mine !== st.seq || !root.isConnected) return;
      st.error = err.code === 'invalid-query' ? 'Pick a range of 1 to 366 days, from before to.' : "Couldn't load the stats. Check your connection and pick a period to try again.";
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
    const list = e.target.closest('[data-list]')?.dataset.list;
    if (list) { st.list = list; draw(); body.querySelector(`[data-list="${list}"]`)?.focus(); return; }
    if (e.target.closest('[data-act="table"]')) { st.table = !st.table; draw(); body.querySelector('[data-act="table"]')?.focus(); }
  });
  // Hover and keyboard focus both show the day; the tip is a status line so screen readers hear it too.
  const show = e => {
    const slot = e.target.closest?.('.slot');
    if (!slot || !st.data) return;
    body.querySelector('.slot.hot')?.classList.remove('hot');
    slot.classList.add('hot');
    body.querySelector('.stx__tip').textContent = describe(bucketed(st.data.perDay)[+slot.dataset.i]);
  };
  const hide = slot => {
    slot.classList.remove('hot');
    body.querySelector('.stx__tip').textContent = '';
  };
  body.addEventListener('pointerover', show);
  body.addEventListener('focusin', show);
  body.addEventListener('focusout', e => { const slot = e.target.closest?.('.slot'); if (slot) hide(slot); });
  body.addEventListener('pointerout', e => { const slot = e.target.closest?.('.slot'); if (slot && document.activeElement !== slot) hide(slot); });

  drawSeg();
  return load();
}

// The shell reads the DOM as it loads, so Node tests import this module without it.
if (globalThis.document) {
  import('./inventory.js').then(shell => shell.registerTab('stats', { render }));
}
