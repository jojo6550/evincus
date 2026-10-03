import { imagesFor, money } from '../../data/catalog.js';
import { loadCatalog, products, eraName } from './store.js';
const esc = t => String(t).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const TAGS = { 'disaster-zone-tee': ['New', true], 'made-for-chaos-tee': ['Distressed'], 'catastrophe-zip-hoodie': ['New', true], 'flaming-eye-tee': ['Core'] };
await loadCatalog();
const PRODUCTS = products();
const grid = document.getElementById('grid');
document.getElementById('total').textContent = PRODUCTS.length;
grid.innerHTML = PRODUCTS.map(p => {
  const imgs = imagesFor(p, p.colors[0].name) || [];
  const [front, back] = [imgs[0], imgs[1] || imgs[0]];
  const tag = TAGS[p.id];
  const colors = p.colors.length > 1 ? p.colors.length + ' colors' : p.colors[0].name;
  return `<a class="card" href="#shop" data-add>
    <div class="card__img">
      ${tag ? `<span class="tag ${tag[1] ? 'tag--hot ' : ''}mono">${tag[0]}</span>` : ''}
      <img src="${esc(front)}" alt="${esc(p.name)}" loading="lazy">
      <img class="alt" src="${esc(back)}" alt="" loading="lazy">
    </div>
    <div class="card__meta"><h3>${esc(p.name)}</h3><span class="price">${money(p.priceCents)}</span><span class="mono">${esc(eraName(p.era))} · ${esc(colors)} · USD</span></div>
  </a>`;
}).join('');
const count = document.getElementById('count');
grid.addEventListener('click', e => {
  const c = e.target.closest('[data-add]'); if (!c) return;
  e.preventDefault();
  count.value = (+count.value || 0) + 1;
  count.textContent = count.value;
});
document.getElementById('signup').addEventListener('submit', e => {
  e.preventDefault();
  const v = document.getElementById('email').value.trim();
  document.getElementById('note').textContent = /.+@.+\..+/.test(v) ? "You're on the list. Demo only, nothing was sent." : 'Enter a valid email address.';
});
