import { imagesFor } from '../../data/catalog.js';
import { loadCatalog, products, eras, eraName, isLive } from './store.js';
import * as cart from './cart.js';
import { refreshQuote } from './quote.js';
import { initBag } from './bag.js';
import { initProductView, openProduct } from './product-view.js';
import { initSale, priceHtml, saleTag } from './sale.js';
const esc = t => String(t).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const TAGS = { 'disaster-zone-tee': ['New', true], 'made-for-chaos-tee': ['Distressed'], 'catastrophe-zip-hoodie': ['New', true], 'flaming-eye-tee': ['Core'] };
await loadCatalog();
initSale();
const PRODUCTS = products();
const grid = document.getElementById('grid');
document.getElementById('total').textContent = PRODUCTS.length;
document.getElementById('pieces').textContent = PRODUCTS.length;
grid.innerHTML = PRODUCTS.map(p => {
  const imgs = imagesFor(p, p.colors[0].name) || [];
  const [front, back] = [imgs[0], imgs[1] || imgs[0]];
  const tag = !p.buyable && isLive() ? [p.soldOut ? 'Sold out' : 'Ended'] : p.sale ? [saleTag(p), true] : TAGS[p.id];
  const colors = p.colors.length > 1 ? p.colors.length + ' colors' : p.colors[0].name;
  return `<a class="card" href="#p-${esc(p.id)}" data-product="${esc(p.id)}" data-era="${esc(p.era)}">
    <div class="card__img">
      ${tag ? `<span class="tag ${tag[1] ? 'tag--hot ' : ''}mono">${tag[0]}</span>` : ''}
      <img src="${esc(front)}" alt="${esc(p.name)}" loading="lazy">
      <img class="alt" src="${esc(back)}" alt="" loading="lazy">
    </div>
    <div class="card__meta"><h3>${esc(p.name)}</h3><span class="price">${priceHtml(p)}</span><span class="mono">${esc(eraName(p.era))} · ${esc(colors)} · USD</span></div>
  </a>`;
}).join('');
grid.addEventListener('click', e => {
  const c = e.target.closest('[data-product]'); if (!c) return;
  e.preventDefault();
  openProduct(c.dataset.product);
});

// Era filter: hides and shows the cells already in the grid.
const ERAS = eras();
const filterEl = document.getElementById('eraFilter');
const introEl = document.getElementById('eraIntro');
const released = ERAS.filter(e => e.status !== 'upcoming');
const inEra = slug => PRODUCTS.filter(p => p.era === slug).length;
filterEl.innerHTML = [['', 'All', PRODUCTS.length], ...released.map(e => [e.slug, e.name, inEra(e.slug)])]
  .map(([slug, name, n]) => `<button type="button" class="era-btn mono" data-era="${esc(slug)}" aria-pressed="false">${esc(name)} <span>${n}</span></button>`).join('');
document.getElementById('teasers').innerHTML = ERAS.filter(e => e.status === 'upcoming').map(e => {
  const when = new Date(e.dropsAt).toLocaleString(undefined, { dateStyle: 'long', timeStyle: 'short' });
  return `<article class="teaser">
    ${e.hero ? `<img src="${esc(e.hero)}" alt="${esc(e.name)} collection preview" loading="lazy">` : ''}
    <div class="teaser__copy">
      <span class="mono u-hazard">Coming soon</span>
      <h3>${esc(e.name)}</h3>
      ${e.tagline ? `<p>${esc(e.tagline)}</p>` : ''}
      <p class="mono u-smoke">Drops ${esc(when)}. Follow <a href="https://www.instagram.com/evincus.sw/" target="_blank" rel="noopener">@evincus.sw</a> to catch it first.</p>
    </div>
  </article>`;
}).join('');
function setEra(slug, { scroll = false, push = true } = {}) {
  const era = released.find(e => e.slug === slug);
  const active = era ? era.slug : '';
  filterEl.querySelectorAll('.era-btn').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.era === active)));
  grid.querySelectorAll('.card').forEach(c => { c.hidden = !!active && c.dataset.era !== active; });
  introEl.innerHTML = era ? `<h3>${esc(era.name)}</h3>${era.tagline ? `<p class="era-intro__tag">${esc(era.tagline)}</p>` : ''}${era.story ? `<p>${esc(era.story)}</p>` : ''}${era.status === 'archived' ? `<p class="era-intro__ended mono">This collection has ended. Its pieces stay here to look at, but they can't be bought.</p>` : ''}` : '';
  if (push) history.replaceState(null, '', active ? `#era-${active}` : '#shop');
  if (scroll) document.getElementById('shop').scrollIntoView();
}
filterEl.addEventListener('click', e => { const b = e.target.closest('.era-btn'); if (b) setEra(b.dataset.era); });
const count = document.getElementById('count');
const showCount = () => { count.textContent = cart.count(); };
showCount();
cart.onChange(showCount);
initProductView();
initBag();
refreshQuote();
const fromHash = () => {
  const m = /^#p-(.+)$/.exec(location.hash); if (m) { openProduct(m[1]); return; }
  const e = /^#era-(.+)$/.exec(location.hash); if (e) setEra(e[1], { scroll: true, push: false });
};
fromHash();
window.addEventListener('hashchange', fromHash);
document.getElementById('signup').addEventListener('submit', e => {
  e.preventDefault();
  const v = document.getElementById('email').value.trim();
  document.getElementById('note').textContent = /.+@.+\..+/.test(v) ? "You're on the list. Demo only, nothing was sent." : 'Enter a valid email address.';
});
