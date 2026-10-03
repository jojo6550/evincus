import { home }     from '../../pages/home.js';
import { shop }     from '../../pages/shop.js';
import { product }  from '../../pages/product.js';
import { about }    from '../../pages/about.js';
import { checkout } from '../../pages/checkout.js';
import { thankYou } from '../../pages/thank-you.js';
import * as cart from './cart.js';
import { money } from '../../data/catalog.js';
import { loadCatalog } from './store.js';

const routes = {
  '/':          home,
  '/shop':      shop,
  '/product':   product,
  '/about':     about,
  '/checkout':  checkout,
  '/thank-you': thankYou,
};

const app = document.getElementById('app');
const nav = document.getElementById('nav');
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

// "#/product/99-tee?x=1" → { path: '/product', param: '99-tee', query }
function parseHash() {
  const raw = window.location.hash.replace(/^#/, '') || '/';
  const [pathPart, queryPart = ''] = raw.split('?');
  const segs = pathPart.split('/').filter(Boolean);
  return {
    path: '/' + (segs[0] ?? ''),
    param: segs[1] ? decodeURIComponent(segs[1]) : null,
    query: new URLSearchParams(queryPart),
  };
}

function setActiveNav(path) {
  document.querySelectorAll('[data-nav]').forEach(a => {
    const href = a.getAttribute('href').replace(/^#/, '');
    const on = href === path || (href === '/shop' && path === '/product');
    a.classList.toggle('active', on);
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
}

let first = true;
async function navigate() {
  const route = parseHash();
  const page = routes[route.path] ?? home;

  if (!first && !reduceMotion.matches) {
    app.classList.add('page-exit');
    await new Promise(r => setTimeout(r, 220));
  }

  app.innerHTML = page.render(route);
  document.body.dataset.page = route.path.slice(1) || 'home';
  window.scrollTo({ top: 0, behavior: 'instant' });
  app.classList.remove('page-exit');
  if (!first) app.focus({ preventScroll: true });
  first = false;

  page.init?.(route);
  setActiveNav(route.path);
  closeBag(false);
  onScroll();
}

/* ── Nav state ─────────────────────────────── */
function onScroll() { nav.classList.toggle('solid', window.scrollY > 24); }
window.addEventListener('scroll', onScroll, { passive: true });

/* ── Bag drawer ────────────────────────────── */
const bag      = document.getElementById('bag');
const scrim    = document.getElementById('scrim');
const bagBody  = document.getElementById('bagBody');
const bagFoot  = document.getElementById('bagFoot');
const bagCount = document.getElementById('bagCount');
const openBtn  = document.getElementById('bagOpen');
let lastFocus = null;

function renderBag() {
  const lines = cart.lines();
  const n = cart.count();
  bagCount.textContent = n;
  openBtn.setAttribute('aria-label', `Bag, ${n} item${n === 1 ? '' : 's'}`);

  if (!lines.length) {
    bagBody.innerHTML = `
      <div class="bag-empty">
        <p>Your bag is empty.</p>
        <a href="#/shop" class="btn btn-light">Shop the collection</a>
      </div>`;
    bagFoot.innerHTML = '';
    return;
  }

  bagBody.innerHTML = lines.map(l => `
    <div class="line" data-key="${l.key}">
      <a href="#/product/${l.id}" class="line-img"><img src="${l.image}" alt="" loading="lazy"></a>
      <div class="line-info">
        <a href="#/product/${l.id}" class="line-name">${l.name}</a>
        <div class="line-meta">${l.color}, size ${l.size}</div>
        <div class="qty" aria-label="Quantity">
          <button type="button" data-act="dec" aria-label="Remove one">−</button>
          <span>${l.qty}</span>
          <button type="button" data-act="inc" aria-label="Add one">+</button>
        </div>
      </div>
      <div class="line-end">
        <span>${money(l.totalCents)}</span>
        <button type="button" class="text-btn" data-act="remove">Remove</button>
      </div>
    </div>`).join('');

  bagFoot.innerHTML = `
    <div class="sum-row"><span>Subtotal</span><span>${money(cart.subtotal())}</span></div>
    <a href="#/checkout" class="btn btn-light btn-block">Check out</a>`;
}

bagBody.addEventListener('click', e => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const key = btn.closest('.line').dataset.key;
  const line = cart.lines().find(l => l.key === key);
  if (!line) return;
  if (btn.dataset.act === 'inc') cart.setQty(key, line.qty + 1);
  if (btn.dataset.act === 'dec') cart.setQty(key, line.qty - 1);
  if (btn.dataset.act === 'remove') cart.remove(key);
});

export function openBag() {
  lastFocus = document.activeElement;
  scrim.hidden = false;
  requestAnimationFrame(() => {
    document.body.classList.add('bag-open');
    bag.setAttribute('aria-hidden', 'false');
    document.getElementById('bagClose').focus();
  });
}

function closeBag(restore = true) {
  if (!document.body.classList.contains('bag-open')) return;
  document.body.classList.remove('bag-open');
  bag.setAttribute('aria-hidden', 'true');
  setTimeout(() => { scrim.hidden = true; }, 400);
  if (restore) lastFocus?.focus();
}

openBtn.addEventListener('click', openBag);
document.getElementById('bagClose').addEventListener('click', () => closeBag());
scrim.addEventListener('click', () => closeBag());
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeBag();
  // Keep focus inside the drawer while it's open
  if (e.key === 'Tab' && document.body.classList.contains('bag-open')) {
    const f = bag.querySelectorAll('a[href], button:not([disabled])');
    if (!f.length) return;
    const firstEl = f[0], lastEl = f[f.length - 1];
    if (e.shiftKey && document.activeElement === firstEl) { e.preventDefault(); lastEl.focus(); }
    else if (!e.shiftKey && document.activeElement === lastEl) { e.preventDefault(); firstEl.focus(); }
  }
});

cart.onChange(() => {
  renderBag();
  bagCount.classList.remove('bump');
  void bagCount.offsetWidth;
  bagCount.classList.add('bump');
});

await loadCatalog();
renderBag();
window.addEventListener('hashchange', navigate);
navigate();
