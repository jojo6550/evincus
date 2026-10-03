import { products, site } from '../assets/js/store.js';
import { card } from '../assets/js/ui.js';

export const shop = {
  render({ query }) {
    const PRODUCTS = products();
    const CATEGORIES = site().categories;
    const active = CATEGORIES.some(c => c.id === query.get('c')) ? query.get('c') : 'all';
    return /* html */`
<section class="page-head">
  <div class="wrap">
    <h1 class="display-lg">Shop</h1>
    <div class="filters" role="group" aria-label="Filter by category">
      ${CATEGORIES.map(c => `
        <button type="button" class="chip" data-cat="${c.id}" aria-pressed="${c.id === active}">
          ${c.name} <span class="chip-n">${c.id === 'all' ? PRODUCTS.length : PRODUCTS.filter(p => p.category === c.id).length}</span>
        </button>`).join('')}
    </div>
  </div>
</section>

<section class="block block-tight">
  <div class="wrap">
    <div class="grid" id="shopGrid">
      ${PRODUCTS.map((p, i) => `<div class="grid-cell" data-cat="${p.category}"${active !== 'all' && p.category !== active ? ' hidden' : ''}>${card(p, { eager: i < 4 })}</div>`).join('')}
    </div>
  </div>
</section>`;
  },

  init() {
    const chips = document.querySelectorAll('.chip');
    const cells = document.querySelectorAll('.grid-cell');
    chips.forEach(chip => chip.addEventListener('click', () => {
      const cat = chip.dataset.cat;
      chips.forEach(c => c.setAttribute('aria-pressed', c === chip));
      const grid = document.getElementById('shopGrid');
      grid.classList.add('is-filtering');
      setTimeout(() => {
        cells.forEach(cell => { cell.hidden = cat !== 'all' && cell.dataset.cat !== cat; });
        grid.classList.remove('is-filtering');
      }, 160);
      // Keep the filter in the URL without re-rendering the page
      history.replaceState(null, '', cat === 'all' ? '#/shop' : `#/shop?c=${cat}`);
    }));
  },
};
