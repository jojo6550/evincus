// HTML for the Inventory tab's list and product page. Every server value goes through esc().
import { safeImage } from './images.js';
import { variantWidths } from '../../data/photos.js';

export const esc = t => String(t ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const signed = n => (n > 0 ? `+${n}` : n < 0 ? `−${-n}` : '±0');
const money = c => `${c < 0 ? '−' : ''}$${(Math.abs(c) / 100).toFixed(2)}`;
const compact = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1 });
const when = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'America/Jamaica' });
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const attr = (on, name) => (on ? ` ${name}` : '');

export const swatch = c => `<svg class="swatch" viewBox="0 0 20 20" aria-hidden="true"><circle class="swatch__dot" cx="10" cy="10" r="9" fill="${esc(c.hex)}"/>${c.ring ? `<circle cx="10" cy="10" r="4" fill="${esc(c.ring)}"/>` : ''}</svg>`;

// The smallest stored variant of a media path: every photo keeps variantWidths(its largest width).
export const thumb = path => safeImage(path).replace(/-(\d+)\.(webp|jpg)$/, (m, w, ext) => `-${variantWidths(+w)[0]}.${ext}`);

// ---- List ----

const CHIP_LABELS = { all: 'All', low: 'Low', out: 'Out', draft: 'Draft', archived: 'Archived' };

export function listHtml({ totals, counts, eras, opts, owner }) {
  const chip = name => `<button type="button" class="chip" data-chip="${name}" aria-pressed="${opts.chip === name}">${CHIP_LABELS[name]} <em>${counts[name]}</em></button>`;
  const tile = (n, label) => `<div class="tile"><b>${esc(n)}</b><small>${label}</small></div>`;
  return `
    <div class="inv__top">
      <input type="search" name="q" value="${esc(opts.q)}" placeholder="Search products, SKU…" aria-label="Search products by name or SKU" autocomplete="off">
      <a class="btn btn--line" href="#inventory/eras">Eras</a>
      ${owner ? '<a class="btn" href="#inventory/new">+ Product</a>' : ''}
    </div>
    <div class="chips" role="group" aria-label="Show">
      ${Object.keys(CHIP_LABELS).map(chip).join('')}
      <select class="chip" name="era" aria-label="Era">
        <option value="">All eras</option>
        ${eras.map(e => `<option value="${esc(e.slug)}"${attr(opts.era === e.slug, 'selected')}>${esc(e.name)}</option>`).join('')}
      </select>
    </div>
    <div class="tiles">
      ${tile(totals.onHand, 'Units on hand')}${tile(totals.committed, 'Committed')}
      ${totals.stockCents === undefined ? '' : tile(compact.format(totals.stockCents / 100), 'Stock at cost')}
    </div>
    <ul class="plist" aria-label="Products"></ul>`;
}

const HEAD = '<li class="plist__head" aria-hidden="true"><span></span><span>Product</span><span>Era</span><span>Variants</span><span>On hand</span><span>Committed</span><span>Available</span></li>';

export function rowsHtml(list, eraNames) {
  if (!list.length) return '<li class="empty">No products match.</li>';
  return HEAD + list.map(p => {
    const tags = [p.out ? `<span class="tag tag--out">${p.out} OUT</span>` : p.low ? '<span class="tag tag--low">LOW</span>' : '',
      p.status === 'draft' ? '<span class="tag">DRAFT</span>' : p.status === 'archived' ? '<span class="tag">ARCHIVED</span>' : ''].join('');
    const img = p.cover ? `<img class="prow__img" src="/${esc(thumb(p.cover))}" alt="" loading="lazy" decoding="async">` : '<span class="prow__img"></span>';
    return `<li><a class="prow" href="#inventory/${encodeURIComponent(p.id)}">
      ${img}
      <span class="prow__name"><b>${esc(p.name || p.id)}</b>${tags}</span>
      <span class="prow__meta"><span>${esc(eraNames[p.era] ?? p.era)}</span><span>${plural(p.variants, 'variant')}</span></span>
      <span class="prow__num prow__wide">${p.onHand}</span><span class="prow__num prow__wide">${p.committed}</span>
      <span class="prow__num prow__avail"><b>${p.available}</b><small>available</small></span>
    </a></li>`;
  }).join('');
}

// ---- Product page ----

// Server error codes → [the field to mark, what to tell the owner].
export const ERRORS = {
  'name-required': ['f-name', 'Add a name before making it Active.'], 'name-invalid': ['f-name', 'The name is too long.'],
  'description-invalid': ['f-description', 'The description is too long.'], 'fabric-invalid': ['f-fabric', 'The fabric is too long.'],
  'category-invalid': ['f-category', 'The category is too long.'], 'era-unknown': ['f-era', 'Pick an era.'],
  'price-required': ['f-price', 'Add a price before making it Active.'], 'price-invalid': ['f-price', 'The price must be more than 0.'],
  'sale-price-invalid': ['f-sale', 'The sale price must be more than 0 and less than the price.'],
  'cost-invalid': ['f-cost', 'Cost per item must be 0 or more.'], 'low-stock-invalid': ['f-low', 'Low stock at must be a whole number, 0 or more.'],
  'sizes-required': ['s-new', 'Add a size before making it Active.'], 'size-invalid': ['s-new', 'Size names need 1 to 100 characters and no "|".'],
  'size-duplicate': ['s-new', 'Two sizes have the same name.'], 'size-has-stock': [null, 'A size with stock can’t be removed. Bring its stock to 0 first.'],
  'colors-required': [null, 'Add a colour before making it Active.'], 'color-invalid': [null, 'Colour names need 1 to 100 characters and no "|".'],
  'color-duplicate': [null, 'Two colours have the same name.'], 'color-has-stock': [null, 'A colour with stock can’t be removed. Bring its stock to 0 first.'],
  'color-committed': [null, 'A colour with units promised to orders can’t be renamed.'], 'photo-required': [null, 'Add a photo before making it Active.'],
  'sku-taken': [null, 'A SKU is already used, here or by another product. Change the marked one.'],
  'sku-invalid': [null, 'SKUs need 1 to 64 characters.'],
  'id-invalid': ['f-id', 'The ID needs lowercase letters, numbers and single dashes, and can’t be “new”.'],
  'product-exists': ['f-id', 'A product with that ID already exists. Pick another ID.'],
  'rename-invalid': [null, 'A renamed colour no longer matches the saved colours. Reload the product and rename it again.'],
  'hex-invalid': [null, 'A colour swatch isn’t a valid colour. Pick it again.'],
  'id-changed': [null, 'A product’s ID can’t change once it’s saved. Reload the product.'],
  'status-invalid': ['f-status', 'Pick Active, Draft or Archived.'],
};

const STATUSES = { active: 'Active', draft: 'Draft', archived: 'Archived' };
const REASONS = { received: 'Received', correction: 'Correction', damaged: 'Damaged', returned: 'Returned', other: 'Other' };
const HISTORY = { ...REASONS, order: 'Order', 'hold-released': 'Hold expired' };
const cents = v => (v == null ? '' : (v / 100).toFixed(2));

export function marginText(p) {
  if (!(p.priceCents > 0) || p.costCents == null || Number.isNaN(p.costCents)) return 'Add a price and cost to see the margin.';
  const profit = p.priceCents - p.costCents;
  return `Margin ${Math.round(profit / p.priceCents * 100)}% · profit ${money(profit)} per item (before GCT and fees)`;
}

const field = (label, id, input) => `<div class="field"><label for="${id}">${label}</label>${input}</div>`;

function optionsHtml(pg, off) {
  const { edited: e } = pg;
  const lock = attr(pg.stockLocked, 'disabled'); // removing a variant would change the locked stock changes
  const colors = e.colors.map((c, i) => `
    <li class="crow">
      ${swatch(c)}
      <input id="c-name-${i}" name="cname" data-i="${i}" value="${esc(c.name)}" maxlength="100" aria-label="Colour ${i + 1} name"${off}>
      <input id="c-hex-${i}" name="chex" data-i="${i}" type="color" value="${esc(c.hex)}" aria-label="Colour ${i + 1} swatch"${off}>
      ${c.from && c.from !== c.name ? `<small class="note">was ${esc(c.from)}</small>` : ''}
      ${pg.owner ? `<button type="button" class="btn btn--line" id="c-del-${i}" data-cdel="${i}" aria-label="Remove ${esc(c.name || 'new colour')}"${lock}>×</button>` : ''}
    </li>`).join('');
  const sizes = e.sizes.map((s, i) => `<li class="pill">${esc(s)}${pg.owner ? ` <button type="button" id="s-del-${i}" data-sdel="${i}" aria-label="Remove size ${esc(s)}"${lock}>×</button>` : ''}</li>`).join('');
  return `
    <h3 class="group">Colours</h3>
    <ul class="crows">${colors}</ul>
    ${pg.owner ? '<button type="button" class="btn btn--line" id="c-add">+ Colour</button>' : ''}
    <h3 class="group">Sizes</h3>
    <ul class="pills">${sizes}</ul>
    ${pg.owner ? `<div class="addsize"><input id="s-new" maxlength="100" placeholder="New size" aria-label="New size"><button type="button" class="btn btn--line" id="s-add">+ Size</button></div>` : ''}
    <label class="toggle" for="f-continue"><span>Keep selling when out of stock<small>Pre-orders. Off: a variant at 0 shows Sold out.</small></span>
      <input id="f-continue" name="continueSelling" type="checkbox"${attr(e.continueSelling, 'checked')}${off}></label>
    <label class="toggle" for="f-low"><span>Low stock at<small>Flag a variant when available is this or less.</small></span>
      <input id="f-low" name="lowStockAt" type="number" inputmode="numeric" min="0" step="1" value="${esc(e.lowStockAt)}"${off}></label>`;
}

// One colour/size row. `n` numbers the row so focus survives a redraw.
export function stockRow(pg, c, s, n) {
  const key = `${c.from ?? c.tmp}|${s}`; // the stock document's key for a loaded colour; SKUs use it for every row
  const row = c.from === null ? undefined : pg.stock[key];
  const label = `${c.name} ${s}`;
  const errs = [pg.rowErrors[key], pg.skuErrors[key]].filter(Boolean);
  const sku = pg.owner
    ? `<input class="vrow__sku" id="sku-${n}" name="sku" data-k="${esc(key)}" value="${esc(pg.edited.skus?.[key] ?? '')}" maxlength="64" placeholder="SKU: automatic" aria-label="SKU for ${esc(label)}"${attr(pg.skuErrors[key], 'aria-invalid="true"')}>`
    : `<small>${esc(pg.original.skus?.[key] ?? '')}</small>`;
  const notes = errs.map(m => `<small class="vrow__err">${esc(m)}</small>`).join('');
  const cls = `vrow${errs.length ? ' is-error' : ''}`;
  if (!row) return `<li class="${cls}"><span class="vrow__l">${esc(s)}${sku}<small>New. Save first, then add stock.</small>${notes}</span></li>`;
  const avail = row.onHand - row.committed, d = pg.deltas[key] ?? 0, shown = avail + d;
  const tag = avail <= 0 ? ' <span class="tag tag--out">OUT</span>' : avail <= pg.edited.lowStockAt ? ' <span class="tag tag--low">LOW</span>' : '';
  const lock = attr(pg.stockLocked, 'disabled');
  const control = pg.owner ? `
    <span class="vrow__d${d < 0 ? ' vrow__d--minus' : ''}">${d ? signed(d) : ''}</span>
    <span class="step${d ? ' is-changed' : ''}">
      <button type="button" id="st-minus-${n}" data-step="-1" aria-label="One fewer ${esc(label)}"${attr(pg.stockLocked || d <= Math.min(0, row.committed - row.onHand), 'disabled')}>−</button>
      <input id="st-val-${n}" name="stock" type="number" inputmode="numeric" value="${shown}" aria-label="${esc(label)} available"${lock}>
      <button type="button" id="st-plus-${n}" data-step="1" aria-label="One more ${esc(label)}"${lock}>+</button>
    </span>` : `<b class="vrow__n">${avail}</b>`;
  return `<li class="${cls}" data-key="${esc(key)}" data-n="${n}">
    <span class="vrow__l">${esc(s)}${tag}${sku}<small>on hand ${row.onHand} · committed ${row.committed}</small>${notes}</span>
    ${control}
  </li>`;
}

export function stockHtml(pg) {
  let n = 0;
  const lock = attr(pg.stockLocked, 'disabled');
  const groups = pg.edited.colors.map(c => `<h3 class="group">${swatch(c)}${esc(c.name)}</h3>
    <ul class="vrows">${pg.edited.sizes.map(s => stockRow(pg, c, s, n++)).join('')}</ul>`).join('');
  const lost = pg.stockLocked ? `<div class="pp__conflict" role="alert">
      <p>Couldn’t confirm the stock save. It may have gone through. Retry sends the same changes again and can’t apply them twice. Reload stock shows the real numbers and drops these changes.</p>
      <button type="button" class="btn" data-act="retry">Retry</button> <button type="button" class="btn btn--line" data-act="reload-stock">Reload stock</button>
    </div>` : '';
  const reason = pg.owner ? `<div class="two">
      ${field('Reason for stock changes', 'f-reason', `<select id="f-reason" name="reason"${lock}>${Object.entries(REASONS).map(([k, v]) => `<option value="${k}"${attr(pg.reason === k, 'selected')}>${v}</option>`).join('')}</select>`)}
      ${field('Note', 'f-note', `<input id="f-note" name="note" maxlength="200" value="${esc(pg.note)}" placeholder="Batch from printer"${lock}>`)}
    </div>` : '';
  return lost + (groups || '<p class="note">Add colours and sizes first.</p>') + reason;
}

export function historyItems(items, productId) {
  return items.map(h => {
    const variant = h.key ? h.key.slice(productId.length + 1).replace('|', '/') : '';
    const title = h.reason === 'edit' ? h.summary : [HISTORY[h.reason] ?? h.reason, h.orderId && `order ${h.orderId}`, variant].filter(Boolean).join(' · ');
    const amount = h.reason === 'edit' ? 0 : h.onHand || h.committed;
    const meta = [h.by ?? (h.orderId ? 'shop' : ''), h.at && when.format(new Date(h.at)), h.note && `“${h.note}”`].filter(Boolean).join(' · ');
    return `<li class="hist__i"><span>${esc(title)}<small>${esc(meta)}</small></span>${amount ? `<span class="hist__n hist__n--${amount > 0 ? 'plus' : 'minus'}">${signed(amount)}${h.onHand ? '' : ' committed'}</span>` : ''}</li>`;
  }).join('');
}

export function pageHtml(pg, { conflict, eraName, photos }) {
  const { edited: e, original: o, owner } = pg;
  const off = owner ? '' : ' disabled';
  const available = Object.values(pg.stock).reduce((n, r) => n + r.onHand - r.committed, 0);
  const text = (label, id, name, max) => field(label, id, `<input id="${id}" name="${name}" maxlength="${max}" value="${esc(e[name])}"${off}>`);
  return `
    <a class="pp__back" href="#inventory">‹ Inventory</a>
    ${conflict ? `<div class="pp__conflict" role="alert">
      <p>Someone else saved this product since you opened it. Changed: ${esc(conflict)}. Your edits are still here.</p>
      <button type="button" class="btn" data-act="mine">Use mine</button> <button type="button" class="btn btn--line" data-act="discard">Discard mine</button>
    </div>` : ''}
    <div class="pp__head">
      <h1 class="pp__title">${pg.isNew ? 'New product' : esc(o.name || o.id)}</h1>
      <select id="f-status" name="status" class="pp__status pp__status--${esc(e.status)}" aria-label="Status"${off}>
        ${Object.entries(STATUSES).map(([k, v]) => `<option value="${k}"${attr(e.status === k, 'selected')}>${v}</option>`).join('')}
      </select>
    </div>
    <p class="pp__sub">${pg.isNew ? 'Shoppers can’t see it until it’s Active and its era is live.' : `${esc(eraName)} era · ${plural(Object.keys(pg.stock).length, 'variant')} · ${available} available${o.status === 'active' ? ` · <a href="/products/${encodeURIComponent(o.id)}" target="_blank" rel="noopener">View on store ↗</a>` : ''}`}</p>
    <div class="pp__cols">
      <div class="pp__col">
        <section class="card" aria-labelledby="h-photos"><h2 class="card__title" id="h-photos">Photos <small>per colour · first is the cover</small></h2><div class="card__body" id="photos-body">${photos}</div></section>
        <section class="card" aria-labelledby="h-details"><h2 class="card__title" id="h-details">Details</h2>
          ${text('Name', 'f-name', 'name', 120)}
          ${pg.isNew ? field('ID <small>in the web address; fixed once saved</small>', 'f-id',
            `<input id="f-id" name="id" maxlength="60" value="${esc(e.id)}" autocapitalize="off" autocomplete="off" spellcheck="false">`) : ''}
          ${field('Description', 'f-description', `<textarea id="f-description" name="description" maxlength="5000" rows="4"${off}>${esc(e.description)}</textarea>`)}
          ${text('Fabric', 'f-fabric', 'fabric', 300)}
          <div class="two">
            ${field('Era', 'f-era', `<select id="f-era" name="era"${off}>${pg.eras.map(x => `<option value="${esc(x.slug)}"${attr(e.era === x.slug, 'selected')}>${esc(x.name)}</option>`).join('')}</select>`)}
            ${text('Category', 'f-category', 'category', 60)}
          </div>
        </section>
        <section class="card" aria-labelledby="h-pricing"><h2 class="card__title" id="h-pricing">Pricing</h2>
          <div class="two">
            ${field('Price (USD)', 'f-price', `<input id="f-price" name="priceCents" type="number" inputmode="decimal" min="0.01" step="0.01" value="${cents(e.priceCents)}"${off}>`)}
            ${field('Sale price (USD) <small>blank for none</small>', 'f-sale', `<input id="f-sale" name="salePriceCents" type="number" inputmode="decimal" min="0.01" step="0.01" value="${cents(e.salePriceCents)}"${off}>`)}
            ${owner ? field('Cost per item', 'f-cost', `<input id="f-cost" name="costCents" type="number" inputmode="decimal" min="0" step="0.01" value="${cents(e.costCents)}">`) : ''}
          </div>
          ${owner ? `<p class="margin" id="margin">${esc(marginText(e))}</p>` : ''}
        </section>
        <section class="card" aria-labelledby="h-options"><h2 class="card__title" id="h-options">Options</h2>${optionsHtml(pg, off)}</section>
      </div>
      <div class="pp__col">
        <section class="card" aria-labelledby="h-stock"><h2 class="card__title" id="h-stock">Stock <small>available shown${owner ? ' in the stepper' : ''}</small></h2><div class="card__body" id="stock-body">${stockHtml(pg)}</div></section>
        ${pg.isNew ? '' : `<section class="card" aria-labelledby="h-history"><h2 class="card__title" id="h-history">History <small>this product</small></h2>
          <ul class="hist">${historyItems(pg.history.items, o.id) || '<li class="note">Nothing yet.</li>'}</ul>
          ${pg.historyError ? `<p class="note hist__err" role="alert">${esc(pg.historyError)}</p>` : ''}
          ${pg.history.next ? '<button type="button" class="btn btn--line" id="hist-more">Load more</button>' : ''}
        </section>`}
      </div>
    </div>
    ${owner ? '<div class="savebar" hidden><p class="savebar__text" id="savebar-text" aria-live="polite"></p><button type="button" class="btn" id="save">Save</button></div>' : ''}`;
}
