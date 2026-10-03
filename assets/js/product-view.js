// Product view: a native <dialog> opened from the grid or a #p-<id> link.
import { imagesFor, money } from '../../data/catalog.js';
import { findProduct, eraName, isLive, site } from './store.js';
import * as cart from './cart.js';
import { openBag } from './bag.js';

const esc = t => String(t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let dialog, body;
let p = null;
let color = '';
let size = '';

function buttonState(p, color, size) {
  if (!isLive()) return { text: 'Checking availability', disabled: true };
  if (!p.buyable) return { text: p.soldOut ? 'Sold out' : 'No longer sold', disabled: true };
  if (!size) return { text: 'Select a size', disabled: true };
  if (p.soldOutVariants.includes(`${color}|${size}`)) return { text: 'Sold out in this size', disabled: true };
  return { text: `Add to bag, ${money(p.priceCents)}`, disabled: false };
}

function dot(c) {
  const ring = c.ring ? `<circle cx="10" cy="10" r="4" fill="${esc(c.ring)}"/>` : '';
  return `<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="9" fill="${esc(c.hex)}"/>${ring}</svg>`;
}

function galleryHtml() {
  const imgs = imagesFor(p, color) ?? [];
  const thumbs = imgs.length > 1 ? `
    <div class="pdp__thumbs">
      ${imgs.map((src, i) => `
        <button type="button" class="pdp__thumb" data-src="${esc(src)}" aria-label="Show image ${i + 1} of ${imgs.length}"${i === 0 ? ' aria-current="true"' : ''}>
          <img src="${esc(src)}" alt="" loading="lazy">
        </button>`).join('')}
    </div>` : '';
  return `
    <div class="pdp__main">
      <i class="crop tl"></i><i class="crop br"></i>
      ${imgs[0] ? `<img id="pdpMain" src="${esc(imgs[0])}" alt="${esc(`${p.name} in ${color}`)}">` : ''}
    </div>
    ${thumbs}`;
}

function sizeTaken(s) { return p.soldOutVariants.includes(`${color}|${s}`); }

function render() {
  const careNote = site().careNote;
  body.innerHTML = `
    <div class="pdp__gallery" id="pdpGallery">${galleryHtml()}</div>
    <div class="pdp__info">
      <a class="mono u-hazard pdp__era" href="#era-${esc(p.era)}">${esc(eraName(p.era))} collection</a>
      <h2 id="pdpName">${esc(p.name)}</h2>
      <p class="pdp__price"><span>${money(p.priceCents)}</span> <span class="mono u-smoke">USD</span></p>

      <fieldset class="pdp__opt">
        <legend class="mono">Colour <span class="pdp__chosen" id="pdpColor">${esc(color)}</span></legend>
        <div class="swatches">
          ${p.colors.map(c => `
            <label class="swatch" title="${esc(c.name)}">
              <input type="radio" name="pdp-color" value="${esc(c.name)}"${c.name === color ? ' checked' : ''}>
              ${dot(c)}
              <span class="sr-only">${esc(c.name)}</span>
            </label>`).join('')}
        </div>
      </fieldset>

      <fieldset class="pdp__opt">
        <legend class="mono">Size <span class="pdp__chosen" id="pdpSize">${esc(size)}</span></legend>
        <div class="sizes">
          ${p.sizes.map(s => `
            <label class="size">
              <input type="radio" name="pdp-size" value="${esc(s)}"${s === size ? ' checked' : ''}>
              <span>${esc(s)}</span>
            </label>`).join('')}
        </div>
      </fieldset>

      <button type="button" class="btn btn--solid pdp__add" id="pdpAdd"></button>

      <dl class="pdp__facts">
        ${p.fabric ? `<div><dt class="mono">Fabric</dt><dd>${esc(p.fabric)}</dd></div>` : ''}
        ${careNote ? `<div><dt class="mono">Care</dt><dd>${esc(careNote)}</dd></div>` : ''}
      </dl>
    </div>`;
  sync();
}

// Updates the parts that depend on the choices without re-rendering (keeps keyboard focus in place).
function sync() {
  const state = buttonState(p, color, size);
  const add = body.querySelector('#pdpAdd');
  add.textContent = state.text;
  add.disabled = state.disabled;
  body.querySelector('#pdpColor').textContent = color;
  body.querySelector('#pdpSize').textContent = size;
  body.querySelectorAll('.size').forEach(l => l.classList.toggle('is-out', sizeTaken(l.querySelector('input').value)));
}

function onChange(e) {
  if (e.target.name === 'pdp-color') {
    const before = imagesFor(p, color);
    color = e.target.value;
    if (p.colors.find(c => c.name === color)?.images && imagesFor(p, color) !== before) {
      body.querySelector('#pdpGallery').innerHTML = galleryHtml();
    }
  }
  if (e.target.name === 'pdp-size') size = e.target.value;
  sync();
}

function onClick(e) {
  const era = e.target.closest('.pdp__era');
  if (era) {
    e.preventDefault();
    const hash = era.getAttribute('href');
    dialog.close();
    location.hash = hash;
    return;
  }
  const thumb = e.target.closest('.pdp__thumb');
  if (thumb) {
    body.querySelector('#pdpMain').src = thumb.dataset.src;
    body.querySelectorAll('.pdp__thumb').forEach(t => t.removeAttribute('aria-current'));
    thumb.setAttribute('aria-current', 'true');
    return;
  }
  if (e.target.closest('#pdpAdd') && !buttonState(p, color, size).disabled) {
    cart.add(p.id, color, size);
    dialog.close();
    openBag();
  }
}

export function openProduct(id) {
  const found = findProduct(id);
  if (!found) {
    history.replaceState(null, '', '#shop');
    return;
  }
  p = found;
  color = p.colors[0].name;
  size = p.sizes.length === 1 ? p.sizes[0] : '';
  render();
  history.replaceState(null, '', `#p-${p.id}`);
  if (!dialog.open) dialog.showModal();
  body.scrollTop = 0;
}

export function initProductView() {
  dialog = document.getElementById('pdp');
  body = document.getElementById('pdpBody');
  body.addEventListener('change', onChange);
  body.addEventListener('click', onClick);
  document.getElementById('pdpClose').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', e => {
    if (e.target !== dialog) return;
    const r = dialog.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dialog.close();
  });
  dialog.addEventListener('close', () => { if (location.hash.startsWith('#p-')) history.replaceState(null, '', '#shop'); });
}
