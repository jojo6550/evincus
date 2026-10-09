import { loadCatalog, products, eras } from './store.js';
import * as cart from './cart.js';
import { initBag } from './bag.js';
import { initProductView } from './product-view.js';
import { initSale, eraSaleNote } from './sale.js';

const esc = t => String(t).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const fmt = iso => new Date(iso).toLocaleString(undefined, { dateStyle: 'long', timeStyle: 'short' });

const STATUS = {
  live: ['Live now', 'era-card__status--live'],
  archived: ['Ended', ''],
  upcoming: ['Coming soon', 'era-card__status--soon'],
};

function note(era) {
  if (era.status === 'upcoming' && era.dropsAt) return `Drops ${fmt(era.dropsAt)}`;
  if (era.status === 'archived') return "Ended. Pieces can be viewed but not bought";
  if (era.endsAt) return `Available until ${fmt(era.endsAt)}`;
  return '';
}

function card(era, count) {
  const [label, cls] = STATUS[era.status] ?? STATUS.live;
  const open = era.status !== 'upcoming';
  const body = `
    <div class="era-card__img">${era.hero ? `<img src="${esc(era.hero)}" alt="${esc(era.name)} collection" loading="lazy">` : ''}</div>
    <div class="era-card__copy">
      <span class="era-card__status mono ${cls}">${label}</span>
      <h2>${esc(era.name)}</h2>
      ${era.tagline ? `<p class="era-card__tag">${esc(era.tagline)}</p>` : ''}
      ${era.story ? `<p>${esc(era.story)}</p>` : ''}
      <p class="mono u-smoke">${[open && `${count} ${count === 1 ? 'piece' : 'pieces'}`, note(era)].filter(Boolean).map(esc).join(' · ')}</p>
      ${era.status === 'live' && eraSaleNote(era.slug) ? `<p class="era-card__sale mono">${esc(eraSaleNote(era.slug))}</p>` : ''}
      ${open ? '<span class="era-card__go mono">Shop this era →</span>' : ''}
    </div>`;
  return open
    ? `<a class="era-card" href="index.html#era-${esc(era.slug)}">${body}</a>`
    : `<article class="era-card era-card--soon">${body}</article>`;
}

await loadCatalog();
initSale();
const all = products();
const countIn = slug => all.filter(p => p.era === slug).length;
const list = eras();
const list_el = document.getElementById('eraList');
list_el.innerHTML = list.length
  ? list.map(e => card(e, countIn(e.slug))).join('')
  : '<p class="mono u-smoke">No eras to show yet.</p>';
document.getElementById('eraTotal').textContent = list.length;

const count = document.getElementById('count');
const showCount = () => { count.textContent = cart.count(); };
showCount();
cart.onChange(showCount);
initProductView();
initBag();
