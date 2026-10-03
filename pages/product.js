import { imagesFor, money } from '../data/catalog.js';
import { findProduct, products, site, eraName } from '../assets/js/store.js';
import { esc, dotStyle, card } from '../assets/js/ui.js';
import * as cart from '../assets/js/cart.js';
import { openBag } from '../assets/js/app.js';

let current = null;

export const product = {
  render({ param }) {
    current = findProduct(param);
    const p = current;
    if (!p) {
      return /* html */`
<section class="page-head page-empty">
  <div class="wrap">
    <h1 class="display-lg">Not found</h1>
    <p class="block-sub">This piece isn't in the store any more. It may have sold out or been renamed.</p>
    <a href="#/shop" class="btn btn-light">Back to the shop</a>
  </div>
</section>`;
    }

    const color = p.colors[0];
    const imgs = imagesFor(p, color.name);
    const related = products().filter(x => x.id !== p.id && (x.category === p.category || x.era === p.era)).slice(0, 4);

    return /* html */`
<section class="pdp">
  <div class="wrap pdp-grid">
    <div class="gallery">
      <div class="gallery-main"><img id="mainImg" src="${imgs[0]}" alt="${esc(p.name)} in ${esc(color.name)}"></div>
      <div class="thumbs" id="thumbs">${thumbs(imgs)}</div>
    </div>

    <div class="pdp-info">
      <a href="#/shop" class="crumb">${esc(eraName(p.era))} collection</a>
      <h1 class="pdp-name">${esc(p.name)}</h1>
      <p class="pdp-price">${money(p.priceCents)} <span>USD</span></p>

      <fieldset class="opt">
        <legend>Colour <span id="colorName">${esc(color.name)}</span></legend>
        <div class="swatch-row">
          ${p.colors.map((c, i) => `
            <label class="swatch" title="${esc(c.name)}">
              <input type="radio" name="color" value="${esc(c.name)}"${i === 0 ? ' checked' : ''}>
              <span class="dot dot-lg" style="${dotStyle(c)}"></span>
              <span class="sr">${esc(c.name)}</span>
            </label>`).join('')}
        </div>
      </fieldset>

      <fieldset class="opt">
        <legend>Size</legend>
        <div class="size-row">
          ${p.sizes.map(s => `
            <label class="size">
              <input type="radio" name="size" value="${s}">
              <span>${s}</span>
            </label>`).join('')}
        </div>
      </fieldset>

      <button type="button" class="btn btn-light btn-block" id="addBtn" disabled>Select a size</button>
      <p class="pdp-note">Pay with PayPal or any debit or credit card at checkout.</p>

      <div class="details">
        <details open>
          <summary>Fabric and fit</summary>
          <p>${esc(p.fabric)}.</p>
        </details>
        <details>
          <summary>Care</summary>
          <p>${esc(site().careNote)}</p>
        </details>
        <details>
          <summary>Sizing help</summary>
          <p>Tees run oversized. Size down for a closer fit, or DM <a href="https://www.instagram.com/evincus.sw/" target="_blank" rel="noopener noreferrer">@evincus.sw</a> with your height and usual size.</p>
        </details>
      </div>
    </div>
  </div>
</section>

${related.length ? `
<section class="block">
  <div class="wrap">
    <div class="block-head"><h2 class="display-md">Wear it with</h2></div>
    <div class="grid">${related.map(x => card(x)).join('')}</div>
  </div>
</section>` : ''}`;
  },

  init() {
    const p = current;
    if (!p) return;

    const main = document.getElementById('mainImg');
    const thumbBox = document.getElementById('thumbs');
    const addBtn = document.getElementById('addBtn');
    let color = p.colors[0].name;
    let size = null;

    function show(src) {
      if (main.getAttribute('src') === src) return;
      main.classList.add('swap');
      const next = new Image();
      next.onload = next.onerror = () => {
        main.src = src;
        main.classList.remove('swap');
      };
      next.src = src;
      thumbBox.querySelectorAll('button').forEach(b => b.setAttribute('aria-current', b.dataset.src === src));
    }

    thumbBox.addEventListener('click', e => {
      const b = e.target.closest('button');
      if (b) show(b.dataset.src);
    });

    document.querySelectorAll('input[name="color"]').forEach(r => r.addEventListener('change', () => {
      color = r.value;
      document.getElementById('colorName').textContent = color;
      main.alt = `${p.name} in ${color}`;
      // Only colourways with their own photos swap the gallery
      if (p.colors.find(c => c.name === color)?.images) {
        const imgs = imagesFor(p, color);
        thumbBox.innerHTML = thumbs(imgs);
        show(imgs[0]);
      }
    }));

    document.querySelectorAll('input[name="size"]').forEach(r => r.addEventListener('change', () => {
      size = r.value;
      addBtn.disabled = false;
      addBtn.textContent = `Add to bag, ${money(p.priceCents)}`;
    }));

    addBtn.addEventListener('click', () => {
      if (!size) return;
      cart.add(p.id, color, size);
      openBag();
    });
  },
};

function thumbs(imgs) {
  return imgs.map((src, i) => `
    <button type="button" class="thumb" data-src="${src}" aria-current="${i === 0}" aria-label="View photo ${i + 1}">
      <img src="${src}" alt="" loading="lazy">
    </button>`).join('');
}
