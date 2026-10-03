import { money, imagesFor } from '../../data/catalog.js';

export function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Garment colour as a dot; print colourways get an inner ring in the print colour.
export function dotStyle(c) {
  const ring = c.ring ? `;box-shadow:inset 0 0 0 4px ${c.hex},inset 0 0 0 20px ${c.ring}` : '';
  return `background:${c.hex}${ring}`;
}

export function card(p, { eager = false } = {}) {
  const imgs = imagesFor(p, p.colors[0].name);
  const n = p.colors.length;
  return `
  <a class="card" href="#/product/${p.id}">
    <div class="card-img">
      <img src="${imgs[0]}" alt="${esc(p.name)}" loading="${eager ? 'eager' : 'lazy'}" class="card-a">
      ${imgs[1] ? `<img src="${imgs[1]}" alt="" loading="lazy" class="card-b">` : ''}
    </div>
    <div class="card-row">
      <span class="card-name">${esc(p.name)}</span>
      <span class="card-price">${money(p.priceCents)}</span>
    </div>
    <div class="card-colors">
      <span class="dots" aria-hidden="true">${p.colors.map(c => `<span class="dot" style="${dotStyle(c)}"></span>`).join('')}</span>
      <span>${n} colour${n === 1 ? '' : 's'}</span>
    </div>
  </a>`;
}
