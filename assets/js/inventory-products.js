// Inventory tab: the product list (#inventory) and one page per product (#inventory/<id>).
// The helpers above the UI are pure and exported for tests; nothing here touches the DOM at import.
import { api, newOpId, ApiError } from './inventory-api.js';
import { registerImages } from './images.js';
import * as view from './inventory-products-view.js';

// Product fields the page edits, in save-bar order, with their save-bar names.
const LABELS = {
  id: 'ID', status: 'status', name: 'name', description: 'description', fabric: 'fabric', era: 'era', category: 'category',
  priceCents: 'price', costCents: 'cost', sizes: 'sizes', colors: 'colours', skus: 'SKUs', images: 'photos', continueSelling: 'keep selling', lowStockAt: 'low stock',
};
const CHIPS = {
  all: p => p.status !== 'archived', low: p => p.status !== 'archived' && p.low, out: p => p.status !== 'archived' && p.out > 0,
  draft: p => p.status === 'draft', archived: p => p.status === 'archived',
};

export function filterProducts(list, { q = '', chip = 'all', era = '' } = {}) {
  const needle = q.trim().toLowerCase();
  return list.filter(p => CHIPS[chip](p) && (!era || p.era === era) && (!needle || [p.name, ...p.skus].some(s => s.toLowerCase().includes(needle))));
}

// A copy to edit. Each colour row remembers the name it was loaded with (`from`; null for a new row, which gets a
// `tmp` key starting with '|', a character names can't hold), so renames are known by row, not guessed from names.
// `skus` stays keyed by `<from or tmp>|<size>`, so a SKU typed on a row follows that row through a rename.
export function editable(p) {
  const e = structuredClone(p);
  for (const c of e.colors) c.from = c.name;
  return e;
}
export const rowKey = c => c.from ?? c.tmp;

// The empty product a new one starts from: a Draft in `era`, with the fields the server requires.
export const blankProduct = era => ({
  id: '', era, status: 'draft', name: '', fabric: '', category: '', priceCents: null, costCents: 0,
  sizes: [], colors: [], skus: {}, continueSelling: false, lowStockAt: 3,
});
export const slugify = name => name.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/[^a-z0-9]+/g, '-').slice(0, 60).replace(/^-+|-+$/g, '');

const bare = ({ from, tmp, ...c }) => c;
const value = (p, f) => (f === 'colors' ? p.colors.map(bare) : f === 'description' ? p.description ?? '' : p[f] ?? null);
export const changedFields = (a, b) => Object.keys(LABELS).filter(f => JSON.stringify(value(a, f)) !== JSON.stringify(value(b, f)));

export function pendingSummary(original, edited, deltas) {
  const fields = changedFields(original, edited);
  const moves = Object.values(deltas).filter(Boolean);
  const units = moves.reduce((a, b) => a + b, 0);
  const parts = [fields.map(f => LABELS[f]).join(', '), moves.length && `${moves.length} stock change${moves.length === 1 ? '' : 's'} (${view.signed(units)})`].filter(Boolean);
  return { fields, stockChanges: moves.length, units, text: parts.length ? `Unsaved: ${parts.join(' · ')}` : '' };
}

// The PUT body: renamed rows become `renames`, and each row's SKUs move to its colour's new name. A variant left
// without one gets the server's default.
export function productBody(original, edited) {
  const renames = Object.fromEntries(edited.colors.filter(c => c.from && c.from !== c.name).map(c => [c.from, c.name]));
  const skus = Object.fromEntries(edited.colors.flatMap(c => edited.sizes.map(s => [`${c.name}|${s}`, edited.skus?.[`${rowKey(c)}|${s}`]?.trim()])).filter(([, v]) => v));
  const product = { ...edited, colors: edited.colors.map(bare), skus };
  if (!product.description && original.description === undefined) delete product.description;
  return { product, ...(Object.keys(renames).length && { renames }) };
}

// Stock deltas are keyed by the stock document's variant keys, which a saved rename moves.
export const rekeyDeltas = (deltas, renames = {}) => Object.fromEntries(Object.entries(deltas).map(([k, d]) => {
  const c = k.slice(0, k.indexOf('|'));
  return [(Object.hasOwn(renames, c) ? renames[c] : c) + k.slice(c.length), d];
}));

// Request → opId until it lands, so pressing Save again after a failure resends the same op and it applies once.
const opIds = new Map();
const requestKey = (method, path, body) => `${method} ${path} ${JSON.stringify(body)}`;
async function send(method, path, body) {
  const key = requestKey(method, path, body);
  if (!opIds.has(key)) opIds.set(key, newOpId());
  try {
    await api(method, path, body, { opId: opIds.get(key) });
    opIds.delete(key);
    return 'ok';
  } catch (err) {
    return err;
  }
}

// productId → the stock request whose reply never came (no response, or a 5xx): it may have landed. Until it is
// retried as-is or the stock is reloaded, other stock edits under a new opId could apply on top of it, so none go.
const lost = new Map();
const unanswered = res => res instanceof ApiError && (res.status === 0 || res.status >= 500);
const waiting = message => new ApiError(409, { error: { code: 'stock-unconfirmed', message } });
export const stockUnconfirmed = productId => lost.has(productId);
// After a reload shows the real stock: the lost request is settled either way, so its opId is dropped too.
export function forgetStock(productId) {
  opIds.delete(lost.get(productId));
  lost.delete(productId);
}

const STOCK = '/api/inventory/stock';
// Stock goes first: its keys use the names the stock document has until the product save renames them. `version`
// null creates the product.
export async function saveAll({ productId, original, edited, version, deltas, reason, note }) {
  const out = {};
  const changes = Object.entries(deltas).filter(([, d]) => d).map(([k, delta]) => ({ key: `${productId}|${k}`, delta }));
  if (changes.length) {
    const body = { productId, changes, reason, note };
    if (lost.has(productId) && lost.get(productId) !== requestKey('POST', STOCK, body)) {
      out.stock = waiting('Couldn’t confirm the last stock save. Retry it or reload the stock first.');
    } else {
      out.stock = await send('POST', STOCK, body);
      if (unanswered(out.stock)) lost.set(productId, requestKey('POST', STOCK, body)); else lost.delete(productId);
    }
  }
  if (changedFields(original, edited).length) {
    // A rename would move the keys a lost stock save used, so details wait for it too.
    out.product = lost.has(productId) ? waiting('Details wait until the stock save is confirmed.')
      : await send('PUT', `/api/inventory/products/${encodeURIComponent(productId)}`, { ...productBody(original, edited), version });
  }
  return out;
}

// ---- UI ----

const ERRORS = {
  'name-required': ['f-name', 'Add a name before making it Active.'], 'name-invalid': ['f-name', 'The name is too long.'],
  'description-invalid': ['f-description', 'The description is too long.'], 'fabric-invalid': ['f-fabric', 'The fabric is too long.'],
  'category-invalid': ['f-category', 'The category is too long.'], 'era-unknown': ['f-era', 'Pick an era.'],
  'price-required': ['f-price', 'Add a price before making it Active.'], 'price-invalid': ['f-price', 'The price must be more than 0.'],
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
};
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

let staff = () => null; // the shell's signed-in account, set at registration
const listOpts = { q: '', chip: 'all', era: '' };
let page = null; // the open product page's state; kept across sign-in so unsaved edits survive
let rowSeq = 0; // tmp keys for new colour rows

const dirty = pg => !!pg && pendingSummary(pg.original, pg.edited, pg.deltas).text !== '';
const container = (el, cls, text) => {
  const root = document.createElement('div');
  root.className = cls;
  if (text) root.append(Object.assign(document.createElement('p'), { className: 'note', textContent: text }));
  el.replaceChildren(root);
  return root;
};
function failed(root, err, retry) {
  const p = Object.assign(document.createElement('p'), { className: 'note', textContent: err.message });
  const b = Object.assign(document.createElement('button'), { type: 'button', className: 'btn btn--line', textContent: 'Try again' });
  b.addEventListener('click', retry);
  root.replaceChildren(p, b);
}
// Re-renders part of the page in place, keeping focus on the same control.
function swap(el, html) {
  const id = document.activeElement?.id;
  el.outerHTML = html;
  if (id) document.getElementById(id)?.focus();
}

async function renderList(el) {
  const root = container(el, 'inv', 'Loading…');
  let data, eras;
  try {
    [data, { eras }] = await Promise.all([api('GET', '/api/inventory/products'), api('GET', '/api/inventory/eras')]);
  } catch (err) {
    if (root.isConnected) failed(root, err, () => renderList(el));
    return;
  }
  if (!root.isConnected) return;
  const counts = Object.fromEntries(Object.keys(CHIPS).map(c => [c, data.products.filter(CHIPS[c]).length]));
  root.innerHTML = view.listHtml({ totals: data.totals, counts, eras: eras.map(e => e.era), opts: listOpts, owner: staff()?.role === 'owner' });
  const names = Object.fromEntries(eras.map(e => [e.era.slug, e.era.name]));
  const rows = root.querySelector('.plist');
  const update = () => { rows.innerHTML = view.rowsHtml(filterProducts(data.products, listOpts), names); };
  update();
  root.addEventListener('input', e => {
    if (e.target.name === 'q' || e.target.name === 'era') { listOpts[e.target.name] = e.target.value; update(); }
  });
  root.addEventListener('click', e => {
    const chip = e.target.closest('[data-chip]');
    if (!chip) return;
    listOpts.chip = chip.dataset.chip;
    for (const b of root.querySelectorAll('[data-chip]')) b.setAttribute('aria-pressed', String(b === chip));
    update();
  });
}

// `id` 'new' opens an empty Draft (owners only); its ID is typed, then fixed by the first save.
async function loadPage(el, id) {
  const isNew = id === 'new', who = staff();
  if (isNew && who?.role !== 'owner') return container(el, 'pp', 'Only owners can add products.');
  const root = container(el, 'pp', 'Loading…');
  try {
    const [d, { eras }] = await Promise.all([
      isNew ? null : api('GET', `/api/inventory/products/${encodeURIComponent(id)}`), api('GET', '/api/inventory/eras')]);
    if (!root.isConnected) return;
    const product = d?.product ?? blankProduct(eras[0]?.era.slug ?? '');
    if (d) registerImages(d.media);
    forgetStock(id); // the stock below is fresh, so a save lost before it is settled
    page = {
      el, id, isNew, idTouched: false, email: who.email, owner: who.role === 'owner', eras: eras.map(e => e.era),
      original: product, version: d?.version ?? null, edited: editable(product), stock: d?.stock ?? {}, history: d?.history ?? { items: [], next: null },
      deltas: {}, reason: 'received', note: '', rowErrors: {}, skuErrors: {}, fieldErrors: [], conflict: null, msg: '', saving: false,
    };
    drawPage();
  } catch (err) {
    if (root.isConnected) failed(root, err, () => loadPage(el, id));
  }
}

function drawPage() {
  const pg = page;
  const id = document.activeElement?.id;
  const root = container(pg.el, 'pp');
  const conflict = pg.conflict && changedFields(pg.original, pg.conflict.current).map(f => LABELS[f]).join(', ');
  pg.stockLocked = !pg.isNew && stockUnconfirmed(pg.id);
  root.innerHTML = view.pageHtml(pg, { conflict: conflict ?? '', eraName: pg.eras.find(x => x.slug === pg.original.era)?.name ?? pg.original.era });
  for (const code of pg.fieldErrors) if (ERRORS[code]?.[0]) root.querySelector(`#${ERRORS[code][0]}`)?.setAttribute('aria-invalid', 'true');
  root.addEventListener('input', onInput);
  root.addEventListener('change', onChange);
  root.addEventListener('click', onClick);
  root.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.id === 's-new') { e.preventDefault(); addSize(); } });
  refreshBar();
  if (pg.saving) lockAll(root);
  if (id) document.getElementById(id)?.focus({ preventScroll: true });
}

// While a save is in flight nothing can be edited, so nothing typed meanwhile is lost when the saved product reloads.
const lockAll = root => { for (const c of root.querySelectorAll('input, select, textarea, button')) c.disabled = true; };

function refreshBar() {
  const bar = page.el.querySelector('.savebar');
  if (!bar) return;
  const { text } = pendingSummary(page.original, page.edited, page.deltas);
  bar.hidden = !text && !page.msg;
  bar.querySelector('.savebar__text').textContent = page.msg || text;
  const button = bar.querySelector('#save');
  button.disabled = page.saving || !text;
  button.textContent = page.saving ? 'Saving…' : 'Save';
}

const toCents = v => (v === '' ? null : Math.round(Number(v) * 100));
const PARSE = {
  name: v => v, description: v => v, fabric: v => v, category: v => v, era: v => v, status: v => v,
  priceCents: toCents, costCents: toCents, lowStockAt: v => (v === '' ? null : Number(v)), continueSelling: (v, t) => t.checked,
};

function onInput(e) {
  const t = e.target, pg = page;
  if (Object.hasOwn(PARSE, t.name)) pg.edited[t.name] = PARSE[t.name](t.value, t);
  else if (t.name === 'id') {
    pg.idTouched = true;
    pg.edited.id = t.value;
  }
  else if (t.name === 'sku') {
    pg.edited.skus[t.dataset.k] = t.value;
    delete pg.skuErrors[t.dataset.k];
  } else if (t.name === 'cname') pg.edited.colors[t.dataset.i].name = t.value;
  else if (t.name === 'chex') {
    pg.edited.colors[t.dataset.i].hex = t.value;
    t.parentElement.querySelector('circle').setAttribute('fill', t.value);
  } else if (t.name === 'reason' || t.name === 'note') pg[t.name] = t.value;
  else return;
  if (t.name === 'status') t.className = `pp__status pp__status--${t.value}`;
  // A new product's ID follows its name until the owner types one.
  if (t.name === 'name' && pg.isNew && !pg.idTouched) pg.el.querySelector('#f-id').value = pg.edited.id = slugify(t.value);
  if (t.name === 'priceCents' || t.name === 'costCents') pg.el.querySelector('#margin').textContent = view.marginText(pg.edited);
  t.removeAttribute('aria-invalid');
  pg.msg = '';
  refreshBar();
}

function onChange(e) {
  const t = e.target;
  if (t.name === 'cname' || t.name === 'chex' || t.name === 'lowStockAt') redrawParts();
  else if (t.name === 'stock') {
    const li = t.closest('.vrow');
    const v = Number.parseInt(t.value, 10);
    const row = page.stock[li.dataset.key];
    setDelta(li, Number.isNaN(v) ? page.deltas[li.dataset.key] ?? 0 : v - (row.onHand - row.committed));
  }
}

// Colour names, swatches and LOW tags also show in the photos and stock cards. Only those are redrawn: this runs on
// blur, and replacing the whole page would swallow a click on Save that caused the blur.
function redrawParts() {
  const id = document.activeElement?.id;
  page.el.querySelector('#photos-body').innerHTML = view.photosHtml(page.edited);
  page.el.querySelector('#stock-body').innerHTML = view.stockHtml(page);
  if (id) document.getElementById(id)?.focus({ preventScroll: true });
}

// The shown Available never goes below 0 by lowering (the server's rule: On hand stays ≥ Committed).
function setDelta(li, delta) {
  const pg = page, key = li.dataset.key, row = pg.stock[key];
  const d = Math.max(Math.min(0, row.committed - row.onHand), Math.min(100000, delta));
  if (d) pg.deltas[key] = d; else delete pg.deltas[key];
  delete pg.rowErrors[key];
  pg.msg = '';
  const i = key.indexOf('|');
  swap(li, view.stockRow(pg, pg.edited.colors.find(c => c.from === key.slice(0, i)), key.slice(i + 1), Number(li.dataset.n)));
  refreshBar();
}

function addSize() {
  const input = page.el.querySelector('#s-new');
  const s = input.value.trim();
  if (s && !page.edited.sizes.includes(s)) page.edited.sizes.push(s);
  page.msg = '';
  drawPage();
  page.el.querySelector('#s-new').focus();
}

// For variants going away: drops their pending stock changes and puts their SKUs back as loaded, so neither counts
// as an edit. Keys end in '|<size>'; sizes can't hold '|'.
function dropVariants(gone) {
  const { deltas, edited, original } = page;
  for (const k of Object.keys(deltas)) if (gone(k)) delete deltas[k];
  for (const k of Object.keys(edited.skus)) {
    if (!gone(k)) continue;
    if (Object.hasOwn(original.skus ?? {}, k)) edited.skus[k] = original.skus[k]; else delete edited.skus[k];
  }
}

function onClick(e) {
  const t = e.target.closest('button');
  if (!t) return;
  const pg = page;
  if (t.dataset.step) return setDelta(t.closest('.vrow'), (pg.deltas[t.closest('.vrow').dataset.key] ?? 0) + Number(t.dataset.step));
  if (t.id === 'c-add') {
    pg.edited.colors.push({ name: '', hex: '#000000', from: null, tmp: `|${++rowSeq}` });
    drawPage();
    return pg.el.querySelector(`#c-name-${pg.edited.colors.length - 1}`).focus();
  }
  if (t.dataset.cdel) {
    const [c] = pg.edited.colors.splice(Number(t.dataset.cdel), 1);
    dropVariants(k => k.startsWith(`${rowKey(c)}|`));
  } else if (t.dataset.sdel) {
    const [s] = pg.edited.sizes.splice(Number(t.dataset.sdel), 1);
    dropVariants(k => k.slice(k.lastIndexOf('|') + 1) === s);
  } else if (t.id === 's-add') return addSize();
  else if (t.id === 'save' || t.dataset.act === 'retry') return save();
  else if (t.dataset.act === 'reload-stock') { t.disabled = true; return reloadStock(); }
  else if (t.dataset.act === 'mine') return useMine();
  else if (t.dataset.act === 'discard') { page = null; return loadPage(pg.el, pg.id); }
  else if (t.id === 'hist-more') return more(t);
  else return;
  pg.msg = '';
  drawPage();
}

async function more(button) {
  const pg = page;
  button.disabled = true;
  try {
    const h = await api('GET', `/api/inventory/products/${encodeURIComponent(pg.id)}/history?before=${encodeURIComponent(pg.history.next)}`);
    pg.history = { items: [...pg.history.items, ...h.items], next: h.next };
  } catch (err) {
    pg.msg = `Couldn’t load more history: ${err.message}`;
  }
  if (page === pg) drawPage();
}

// Rebases the edits on the version someone else saved: fields this owner didn't touch take theirs, then saves.
function useMine() {
  const pg = page, { current, version } = pg.conflict;
  const fresh = editable(current), mine = changedFields(pg.original, pg.edited);
  for (const f of Object.keys(LABELS)) if (!mine.includes(f)) pg.edited[f] = fresh[f];
  pg.original = current;
  pg.version = version;
  pg.conflict = null;
  save();
}

const codesOf = err => (err.code === 'invalid-product' ? err.details?.errors ?? [] : [err.code]);
const errorText = err => [...new Set(codesOf(err).map(c => ERRORS[c]?.[1] ?? err.message))].join(' ') || err.message;
const isId = id => SLUG.test(id) && id.length <= 60 && id !== 'new'; // 'new' is the address of this page

async function save() {
  const pg = page;
  if (pg.isNew && !isId(pg.edited.id)) {
    Object.assign(pg, { fieldErrors: ['id-invalid'], msg: `Details not saved: ${ERRORS['id-invalid'][1]}` });
    return drawPage();
  }
  const productId = pg.isNew ? pg.edited.id : pg.id;
  const { renames } = productBody(pg.original, pg.edited);
  Object.assign(pg, { saving: true, msg: '', rowErrors: {}, skuErrors: {}, fieldErrors: [] });
  refreshBar();
  lockAll(pg.el);
  const res = await saveAll({ productId, original: pg.original, edited: pg.edited, version: pg.version, deltas: pg.deltas, reason: pg.reason, note: pg.note });
  if (pg.isNew && res.product === 'ok') {
    page = null; // nothing left unsaved, so leaving asks nothing
    location.hash = `#inventory/${encodeURIComponent(productId)}`;
    return;
  }
  const msgs = [];
  if (res.stock === 'ok') { pg.deltas = {}; pg.note = ''; } else if (res.stock) {
    msgs.push(stockUnconfirmed(pg.id) ? 'Couldn’t confirm the stock save.' : `Stock not saved: ${res.stock.message}`);
    if (res.stock.details?.key) pg.rowErrors[res.stock.details.key.slice(pg.id.length + 1)] = res.stock.message;
  }
  if (res.product && res.product !== 'ok') {
    const err = res.product;
    if (err.code === 'product-changed' && err.details?.current) pg.conflict = err.details;
    pg.fieldErrors = codesOf(err);
    // The server doesn't say which SKU clashed, so every SKU typed on this page is marked.
    const sku = pg.fieldErrors.find(c => c.startsWith('sku-'));
    if (sku) {
      for (const [k, v] of Object.entries(pg.edited.skus)) if (v.trim() && v.trim() !== (pg.original.skus?.[k] ?? '')) pg.skuErrors[k] = ERRORS[sku][1];
    }
    msgs.push(err.code === 'stock-unconfirmed' ? err.message : `Details not saved: ${errorText(err)}`);
  }
  if (res.stock === 'ok' || res.product === 'ok') {
    try {
      const d = await api('GET', `/api/inventory/products/${encodeURIComponent(pg.id)}`);
      registerImages(d.media);
      Object.assign(pg, { stock: d.stock, history: d.history });
      if (res.product === 'ok') {
        Object.assign(pg, { original: d.product, version: d.version, edited: editable(d.product), conflict: null });
        pg.deltas = rekeyDeltas(pg.deltas, renames); // a failed stock part keeps its changes, under the new names
      }
    } catch (err) {
      msgs.push(`Saved, but the page couldn’t refresh: ${err.message}`);
    }
  }
  pg.saving = false;
  pg.msg = msgs.join(' ') || 'Saved.';
  if (page === pg) drawPage();
}

// Settles a stock save whose reply was lost: once the store's real numbers are on screen, the pending changes go.
async function reloadStock() {
  const pg = page;
  try {
    const d = await api('GET', `/api/inventory/products/${encodeURIComponent(pg.id)}`);
    forgetStock(pg.id);
    registerImages(d.media);
    Object.assign(pg, { stock: d.stock, history: d.history, deltas: {}, rowErrors: {}, msg: 'Stock reloaded. Make any stock changes that are still needed.' });
  } catch (err) {
    pg.msg = `Couldn’t reload the stock: ${err.message}`;
  }
  if (page === pg) drawPage();
}

function render(el, [id]) {
  if (!id) { page = null; return renderList(el); }
  // Back from the sign-in screen: the same owner gets their unsaved edits back.
  if (page?.id === id && page.email === staff()?.email && dirty(page)) { page.el = el; return drawPage(); }
  page = null;
  return loadPage(el, id);
}

function canLeave() {
  if (dirty(page) && !confirm('Leave this product? Your unsaved changes will be lost.')) return false;
  page = null;
  return true;
}

// The shell reads the DOM as it loads, so Node tests import this module without it.
if (globalThis.document) {
  import('./inventory.js').then(shell => {
    staff = shell.staff;
    shell.registerTab('inventory', { render, canLeave });
  });
  addEventListener('beforeunload', e => { if (dirty(page)) { e.preventDefault(); e.returnValue = ''; } });
}
