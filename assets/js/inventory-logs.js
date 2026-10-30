// Logs tab (owner): system health and saved log lines. Every server string goes through esc().
import { api } from './inventory-api.js';
import { esc } from './inventory-products-view.js';

const LEVELS = [['', 'All levels'], ['error', 'Errors'], ['warn', 'Warnings'], ['info', 'Info']];
const KINDS = [['', 'All kinds'], ['login', 'Sign-ins'], ['account', 'Accounts'], ['order', 'Orders'], ['stock', 'Stock'], ['product', 'Products'], ['era', 'Eras'], ['sales', 'Sales'], ['media', 'Media'], ['inventory', 'Pulls'], ['operations', 'Operations'], ['retention', 'Retention'], ['unhandled', 'Crashes']];

const mb = n => (typeof n === 'number' ? `${(n / 1048576).toFixed(1)} MB` : 'unknown');
const when = s => (s === 'unknown' || !s ? 'unknown' : esc(String(s).replace('T', ' ').slice(0, 19)) + ' UTC');

export function healthHtml(h) {
  const row = (k, v) => `<div><dt>${k}</dt><dd>${v}</dd></div>`;
  const ops = h.operations ? Object.entries(h.operations).map(([k, v]) => `${esc(k)} ${esc(v)}`).join(', ') : 'unknown';
  return `<dl class="lgx__health">${[
    row('Status', h.ok ? 'OK' : 'Needs attention'),
    row('Disk and scheduler', ops),
    row('Free disk', mb(h.diskFreeBytes)),
    row('Photos', mb(h.mediaBytes)),
    row('Last scheduled run', when(h.lastCronAt)),
    row('Emails waiting to retry', esc(h.emailRetryCount)),
    row('Last digest', esc(h.lastDigestDay)),
    row('Catalog revision', esc(String(h.rev).slice(0, 8))),
    row('Version', esc(h.commit)),
  ].join('')}</dl>`;
}

export function lineHtml(l) {
  const { ts, level, event, route, reqId, account, ...rest } = l;
  const extra = Object.entries(rest).map(([k, v]) => `${esc(k)}=${esc(typeof v === 'string' ? v : JSON.stringify(v))}`).join(' ');
  return `<li class="lgx__line lgx__line--${esc(level)}"><b>${esc(level)}</b> <time>${esc(String(ts).replace('T', ' ').slice(0, 19))}</time> <span>${esc(event)}</span>${account ? ` <em>${esc(account)}</em>` : ''}<small>${esc(route ?? '')}${extra ? ' ' + extra : ''}</small></li>`;
}

const options = list => list.map(([v, label]) => `<option value="${v}">${label}</option>`).join('');

function render(el) {
  el.innerHTML = `<div class="lgx"><section class="card"><h3 class="card__title">System health</h3><div class="lgx__hbody"><p class="note">Loading…</p></div></section>
<section class="card"><h3 class="card__title">Logs <small>kept 30 days</small></h3>
<form class="lgx__filters"><label>Level <select name="level">${options(LEVELS)}</select></label><label>Kind <select name="kind">${options(KINDS)}</select></label></form>
<ul class="lgx__list"></ul><p class="note lgx__msg" role="status"></p><button type="button" class="btn btn--line lgx__more" hidden>Load more</button></section></div>`;
  const root = el.firstElementChild;
  const form = root.querySelector('form'), list = root.querySelector('.lgx__list'), msg = root.querySelector('.lgx__msg'), more = root.querySelector('.lgx__more');
  let next = null, seq = 0;

  async function load(append) {
    const mine = ++seq;
    if (!append) { next = null; more.hidden = true; }
    const q = new URLSearchParams({ level: form.elements.level.value, kind: form.elements.kind.value, ...(append && next && { before: next }) });
    msg.textContent = 'Loading…';
    try {
      const data = await api('GET', `/api/inventory/logs?${q}`);
      if (mine !== seq || !root.isConnected) return;
      if (!append) list.textContent = '';
      list.insertAdjacentHTML('beforeend', data.logs.map(lineHtml).join(''));
      next = data.next;
      msg.textContent = list.children.length ? '' : 'No logs match.';
    } catch {
      if (mine === seq) msg.textContent = "Couldn't load the logs. Try again.";
    }
    more.hidden = !next;
  }

  form.addEventListener('change', () => load(false));
  more.addEventListener('click', () => load(true));
  api('GET', '/api/inventory/health').then(h => { root.querySelector('.lgx__hbody').innerHTML = healthHtml(h); })
    .catch(() => { root.querySelector('.lgx__hbody').textContent = "Couldn't load the health data."; });
  return load(false);
}

// The shell reads the DOM as it loads, so Node tests import this module without it.
if (globalThis.document) {
  import('./inventory.js').then(shell => shell.registerTab('logs', { render }));
}
