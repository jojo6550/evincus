// HTML for the Inventory tab's list and product page. Every server value goes through esc().
import { imageAttrs, safeImage } from './images.js';
import { photoPath, variantWidths } from '../../data/photos.js';

export const esc = t => String(t ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const signed = n => (n > 0 ? `+${n}` : n < 0 ? `−${-n}` : '±0');
const money = c => `${c < 0 ? '−' : ''}$${(Math.abs(c) / 100).toFixed(2)}`;
const compact = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1 });
const when = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'America/Jamaica' });
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const attr = (on, name) => (on ? ` ${name}` : '');

export const swatch = c => `<svg class="swatch" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="9" fill="${esc(c.hex)}"/>${c.ring ? `<circle cx="10" cy="10" r="4" fill="${esc(c.ring)}"/>` : ''}</svg>`;

// The smallest stored variant of a media path: every photo keeps variantWidths(its largest width).
const thumb = path => safeImage(path).replace(/-(\d+)\.(webp|jpg)$/, (m, w, ext) => `-${variantWidths(+w)[0]}.${ext}`);

// ---- List ----

const CHIP_LABELS = { all: 'All', low: 'Low', out: 'Out', draft: 'Draft', archived: 'Archived' };

export function listHtml({ totals, counts, eras, opts }) {
  const chip = name => `<button type="button" class="chip" data-chip="${name}" aria-pressed="${opts.chip === name}">${CHIP_LABELS[name]} <em>${counts[name]}</em></button>`;
  const tile = (n, label) => `<div class="tile"><b>${esc(n)}</b><small>${label}</small></div>`;
  return `
    <input class="inv__search" type="search" name="q" value="${esc(opts.q)}" placeholder="Search products, SKU…" aria-label="Search products by name or SKU" autocomplete="off">
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

const STATUSES = { active: 'Active', draft: 'Draft', archived: 'Archived' };
const REASONS = { received: 'Received', correction: 'Correction', damaged: 'Damaged', returned: 'Returned', other: 'Other' };
const HISTORY = { ...REASONS, order: 'Order' };
const cents = v => (v == null ? '' : (v / 100).toFixed(2));

export function marginText(p) {
  if (!(p.priceCents > 0) || p.costCents == null || Number.isNaN(p.costCents)) return 'Add a price and cost to see the margin.';
  const profit = p.priceCents - p.costCents;
  return `Margin ${Math.round(profit / p.priceCents * 100)}% · profit ${money(profit)} per item (before GCT and fees)`;
}

const field = (label, id, input) => `<div class="field"><label for="${id}">${label}</label>${input}</div>`;

export function photosHtml(p) {
  const groups = [...(p.images?.length ? [{ name: 'All colours', images: p.images }] : []), ...p.colors];
  return groups.map(c => `
    <h3 class="group">${c.hex ? swatch(c) : ''}${esc(c.name)}</h3>
    <div class="photos">${(c.images ?? []).map((r, i) => `<img ${imageAttrs(photoPath(r), '(min-width: 1024px) 110px, 22vw')} alt="${esc(`${c.name} photo ${i + 1}`)}" loading="lazy">`).join('') || '<p class="note">No photos yet.</p>'}</div>`).join('');
}

function optionsHtml(pg, off) {
  const { edited: e } = pg;
  const colors = e.colors.map((c, i) => `
    <li class="crow">
      ${swatch(c)}
      <input id="c-name-${i}" name="cname" data-i="${i}" value="${esc(c.name)}" maxlength="100" aria-label="Colour ${i + 1} name"${off}>
      <input id="c-hex-${i}" name="chex" data-i="${i}" type="color" value="${esc(c.hex)}" aria-label="Colour ${i + 1} swatch"${off}>
      ${c.from && c.from !== c.name ? `<small class="note">was ${esc(c.from)}</small>` : ''}
      ${pg.owner ? `<button type="button" class="btn btn--line" id="c-del-${i}" data-cdel="${i}" aria-label="Remove ${esc(c.name || 'new colour')}">×</button>` : ''}
    </li>`).join('');
  const sizes = e.sizes.map((s, i) => `<li class="pill">${esc(s)}${pg.owner ? ` <button type="button" id="s-del-${i}" data-sdel="${i}" aria-label="Remove size ${esc(s)}">×</button>` : ''}</li>`).join('');
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
  const key = `${c.from ?? c.name}|${s}`;
  const row = c.from === null ? undefined : pg.stock[key];
  if (!row) return `<li class="vrow"><span class="vrow__l">${esc(s)}<small>New. Save first, then add stock.</small></span></li>`;
  const avail = row.onHand - row.committed, d = pg.deltas[key] ?? 0, shown = avail + d;
  const tag = avail <= 0 ? ' <span class="tag tag--out">OUT</span>' : avail <= pg.edited.lowStockAt ? ' <span class="tag tag--low">LOW</span>' : '';
  const err = pg.rowErrors[key];
  const label = `${c.name} ${s}`;
  const control = pg.owner ? `
    <span class="vrow__d${d < 0 ? ' vrow__d--minus' : ''}">${d ? signed(d) : ''}</span>
    <span class="step${d ? ' is-changed' : ''}">
      <button type="button" id="st-minus-${n}" data-step="-1" aria-label="One fewer ${esc(label)}"${attr(d <= Math.min(0, row.committed - row.onHand), 'disabled')}>−</button>
      <input id="st-val-${n}" name="stock" type="number" inputmode="numeric" value="${shown}" aria-label="${esc(label)} available">
      <button type="button" id="st-plus-${n}" data-step="1" aria-label="One more ${esc(label)}">+</button>
    </span>` : `<b class="vrow__n">${avail}</b>`;
  return `<li class="vrow${err ? ' is-error' : ''}" data-key="${esc(key)}" data-n="${n}">
    <span class="vrow__l">${esc(s)} · ${esc(pg.original.skus?.[key] ?? '')}${tag}<small>on hand ${row.onHand} · committed ${row.committed}</small>${err ? `<small class="vrow__err">${esc(err)}</small>` : ''}</span>
    ${control}
  </li>`;
}

export function stockHtml(pg) {
  let n = 0;
  const groups = pg.edited.colors.map(c => `<h3 class="group">${swatch(c)}${esc(c.name)}</h3>
    <ul class="vrows">${pg.edited.sizes.map(s => stockRow(pg, c, s, n++)).join('')}</ul>`).join('');
  const reason = pg.owner ? `<div class="two">
      ${field('Reason for stock changes', 'f-reason', `<select id="f-reason" name="reason">${Object.entries(REASONS).map(([k, v]) => `<option value="${k}"${attr(pg.reason === k, 'selected')}>${v}</option>`).join('')}</select>`)}
      ${field('Note', 'f-note', `<input id="f-note" name="note" maxlength="200" value="${esc(pg.note)}" placeholder="Batch from printer">`)}
    </div>` : '';
  return (groups || '<p class="note">Add colours and sizes first.</p>') + reason;
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

export function pageHtml(pg, { conflict, eraName }) {
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
      <h1 class="pp__title">${esc(o.name || o.id)}</h1>
      <select id="f-status" name="status" class="pp__status pp__status--${esc(e.status)}" aria-label="Status"${off}>
        ${Object.entries(STATUSES).map(([k, v]) => `<option value="${k}"${attr(e.status === k, 'selected')}>${v}</option>`).join('')}
      </select>
    </div>
    <p class="pp__sub">${esc(eraName)} era · ${plural(Object.keys(pg.stock).length, 'variant')} · ${available} available${o.status === 'active' ? ` · <a href="/products/${encodeURIComponent(o.id)}" target="_blank" rel="noopener">View on store ↗</a>` : ''}</p>
    <div class="pp__cols">
      <div class="pp__col">
        <section class="card" aria-labelledby="h-photos"><h2 class="card__title" id="h-photos">Photos <small>per colour · first is the cover</small></h2><div class="card__body" id="photos-body">${photosHtml(e)}</div></section>
        <section class="card" aria-labelledby="h-details"><h2 class="card__title" id="h-details">Details</h2>
          ${text('Name', 'f-name', 'name', 120)}
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
            ${owner ? field('Cost per item', 'f-cost', `<input id="f-cost" name="costCents" type="number" inputmode="decimal" min="0" step="0.01" value="${cents(e.costCents)}">`) : ''}
          </div>
          ${owner ? `<p class="margin" id="margin">${esc(marginText(e))}</p>` : ''}
        </section>
        <section class="card" aria-labelledby="h-options"><h2 class="card__title" id="h-options">Options</h2>${optionsHtml(pg, off)}</section>
      </div>
      <div class="pp__col">
        <section class="card" aria-labelledby="h-stock"><h2 class="card__title" id="h-stock">Stock <small>available shown${owner ? ' in the stepper' : ''}</small></h2><div class="card__body" id="stock-body">${stockHtml(pg)}</div></section>
        <section class="card" aria-labelledby="h-history"><h2 class="card__title" id="h-history">History <small>this product</small></h2>
          <ul class="hist">${historyItems(pg.history.items, o.id) || '<li class="note">Nothing yet.</li>'}</ul>
          ${pg.history.next ? '<button type="button" class="btn btn--line" id="hist-more">Load more</button>' : ''}
        </section>
      </div>
    </div>
    ${owner ? '<div class="savebar" hidden><p class="savebar__text" id="savebar-text" aria-live="polite"></p><button type="button" class="btn" id="save">Save</button></div>' : ''}`;
}
