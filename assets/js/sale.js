// Sale banner and sale prices. Sales come from the API (`npm run discount` starts them); the banner counts down
// the deepest running sale on the API's clock and reloads the page when it ends so prices go back.
import { bestSale, money } from '../../data/catalog.js';
import { sales, eraName, serverNow } from './store.js';

const esc = t => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmt = iso => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const pad = n => String(n).padStart(2, '0');
const UNITS = [['d', 'Days', 86_400_000], ['h', 'Hrs', 3_600_000], ['m', 'Min', 60_000], ['s', 'Sec', 1000]];

export const priceHtml = p => p.compareAtCents > p.priceCents
  ? `<s class="price__was">${money(p.compareAtCents)}</s> <span class="price__now">${money(p.priceCents)}</span>`
  : money(p.priceCents);

export const saleTag = p => (p.sale ? `−${p.sale.percent}%` : '');

// "−20% until Oct 12, 6:00 PM" for an era, or '' when it has no running sale.
export function eraSaleNote(slug) {
  const s = bestSale(sales(), slug, serverNow());
  return s ? `−${s.percent}% until ${fmt(s.endsAt)}` : '';
}

function headline() {
  const now = serverNow();
  return [...sales()]
    .filter(s => Date.parse(s.startsAt) <= now && now < Date.parse(s.endsAt))
    .sort((a, b) => b.percent - a.percent || Date.parse(b.endsAt) - Date.parse(a.endsAt))[0] ?? null;
}

function reloadOnce(id) {
  try {
    const key = `evincus_sale_end_${id}`;
    if (sessionStorage.getItem(key)) return;
    sessionStorage.setItem(key, '1');
  } catch { /* storage blocked: reload anyway, the API clock decides */ }
  location.reload();
}

export function initSale() {
  const el = document.getElementById('sale');
  const s = el && headline();
  if (!s) return;
  const scope = s.label ?? (s.eras ? s.eras.map(eraName).filter(Boolean).join(' + ') : 'Everything');
  el.innerHTML = `
    <div class="sale__inner wrap">
      <p class="sale__deal">
        <span class="sale__word" aria-hidden="true">sale</span>
        <b class="sale__pct">−${s.percent}%</b>
        <span class="sale__scope mono">${esc(scope)}</span>
      </p>
      <div class="sale__clock" role="timer" aria-label="Sale ends ${esc(fmt(s.endsAt))}">
        ${UNITS.map(([u, label]) => `<span class="sale__cell sale__cell--${u}"><b data-u="${u}">00</b><small class="mono">${label}</small></span>`).join('')}
      </div>
      <a class="sale__go mono" href="index.html#shop">Shop the sale <span aria-hidden="true">→</span></a>
    </div>`;
  const cells = Object.fromEntries(UNITS.map(([u]) => [u, el.querySelector(`[data-u="${u}"]`)]));
  const ends = Date.parse(s.endsAt);
  const tick = () => {
    let left = Math.max(0, ends - serverNow());
    for (const [u, , ms] of UNITS) {
      cells[u].textContent = pad(Math.floor(left / ms));
      left %= ms;
    }
    if (ends <= serverNow()) {
      clearInterval(timer);
      reloadOnce(s.id);
    }
  };
  const timer = setInterval(tick, 1000);
  tick();
  el.hidden = false;
}
