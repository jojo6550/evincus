// Inventory tab, Eras section: #inventory/eras (the list and its order) and #inventory/eras/<slug> (one era).
// The helpers above the UI are pure and exported for tests; nothing here touches the DOM at import.
import { api, newOpId, ApiError } from './inventory-api.js';
import { registerImages, imageAttrs } from './images.js';
import { photoPath } from '../../data/photos.js';
import { esc } from './inventory-products-view.js';
import { uploadPhoto, uploadBlock, reorderFocus } from './inventory-photos.js';
import { slugify } from './inventory-products.js';

const DATE = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'America/Jamaica' });

// One step up (-1) or down (1) in the order; the same array when the slug is already at that end.
export function moveSlug(order, slug, d) {
  const i = order.indexOf(slug), j = i + d;
  if (i < 0 || j < 0 || j >= order.length) return order;
  const out = [...order];
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}

export function eraStatus(e, now = new Date()) {
  if (e.state === 'draft') return 'Draft';
  if (e.state === 'archived') return 'Archived';
  if (e.endsAt && new Date(e.endsAt) <= now) return 'Ended';
  if (e.dropsAt && new Date(e.dropsAt) > now) return `Drops ${DATE.format(new Date(e.dropsAt))}`;
  return 'Live';
}

const FIELDS = { name: 'name', tagline: 'tagline', story: 'story', hero: 'hero photo', dropsAt: 'drop date', endsAt: 'end date', state: 'status' };
const blank = () => ({ slug: '', name: '', tagline: '', story: '', hero: null, dropsAt: null, endsAt: null, state: 'draft' });
const val = (e, f) => JSON.stringify(e[f] ?? (f === 'hero' || f.endsWith('At') ? null : ''));
export const changedEraFields = (a, b) => Object.keys(FIELDS).filter(f => val(a, f) !== val(b, f));

const ERRORS = {
  'name-invalid': 'Add a name (up to 100 characters, no spaces at the ends).', 'slug-invalid': 'The address needs lowercase letters, numbers and single dashes.',
  'tagline-invalid': 'The tagline is too long.', 'story-invalid': 'The story is too long.', 'hero-invalid': 'The hero photo isn’t valid. Add it again.',
  'state-invalid': 'Pick Draft, Published or Archived.', 'drops-at-invalid': 'The drop date isn’t valid.', 'ends-at-invalid': 'The end date isn’t valid.',
  'tagline-required': 'Add a tagline before publishing.', 'story-required': 'Add a story before publishing.', 'hero-required': 'Add a hero photo before publishing.',
  'era-exists': 'An era with that address already exists. Pick another.',
};
const errorText = err => (err.code === 'invalid-era' ? (err.details?.errors ?? []).map(c => ERRORS[c] ?? c).join(' ') : ERRORS[err.code]) || err.message;

// ---- UI ----

let staff = () => null;
let state = null; // the open era's page; null elsewhere
const dirty = st => !!st && changedEraFields(st.original, st.edited).length > 0;
// Back from the sign-in screen, the same account's unsaved edits to the same era are kept (as for products).
export const resumes = (st, slug, email) => !!st && st.slug === slug && st.email === email && dirty(st);
export function canLeave() {
  if (dirty(state) && !confirm('Leave this era? Your unsaved changes will be lost.')) return false;
  state = null;
  return true;
}

const toLocal = iso => { if (!iso) return ''; const d = new Date(iso); return new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };
const fromLocal = v => (v ? new Date(v).toISOString() : null);

function setMessage(el, text, retry) {
  const p = Object.assign(document.createElement('p'), { className: 'note', textContent: text });
  el.replaceChildren(p);
  if (retry) {
    const b = Object.assign(document.createElement('button'), { type: 'button', className: 'btn btn--line', textContent: 'Try again' });
    b.addEventListener('click', retry);
    el.append(b);
  }
}

const thumb = hero => (hero ? `<img class="era__img" ${imageAttrs(photoPath(hero), '56px')} alt="" loading="lazy">` : '<span class="era__img"></span>');

function listHtml(d, owner) {
  const rows = d.eras.map(({ era: e, productCount }, i) => `<li class="era" data-slug="${esc(e.slug)}"${owner ? ' draggable="true"' : ''}>
      ${thumb(e.hero)}
      <span class="era__name"><a href="#inventory/eras/${encodeURIComponent(e.slug)}"><b>${esc(e.name)}</b></a>
        <small><span class="tag">${esc(eraStatus(e))}</span> ${productCount} product${productCount === 1 ? '' : 's'}</small></span>
      ${owner ? `<span class="era__move">
        <button type="button" class="btn btn--line" id="er-up-${i}" data-move="${esc(e.slug)}" data-d="-1" aria-label="Move ${esc(e.name)} up, position ${i + 1} of ${d.eras.length}"${i === 0 || d.busy ? ' disabled' : ''}>↑</button>
        <button type="button" class="btn btn--line" id="er-dn-${i}" data-move="${esc(e.slug)}" data-d="1" aria-label="Move ${esc(e.name)} down, position ${i + 1} of ${d.eras.length}"${i === d.eras.length - 1 || d.busy ? ' disabled' : ''}>↓</button>
      </span>` : ''}
    </li>`).join('');
  return `<a class="pp__back" href="#inventory">‹ Inventory</a>
    <div class="pp__head"><h1 class="pp__title">Eras</h1>${owner ? '<a class="btn" href="#inventory/eras/new">+ Era</a>' : ''}</div>
    <p class="note" id="era-msg" role="status">${esc(d.msg ?? '')}</p>
    <ol class="eras" aria-label="Eras in store order">${rows || '<li class="empty">No eras yet.</li>'}</ol>`;
}

async function renderList(el, msg = '') {
  const root = Object.assign(document.createElement('div'), { className: 'inv' });
  setMessage(root, 'Loading…');
  el.replaceChildren(root);
  let d;
  try {
    d = await api('GET', '/api/inventory/eras');
  } catch (err) {
    if (root.isConnected) setMessage(root, err.message, () => renderList(el));
    return;
  }
  if (!root.isConnected) return;
  registerImages(d.media);
  const owner = staff()?.role === 'owner';
  const draw = () => { root.innerHTML = listHtml(d, owner); };
  // Saves the new order at once, under its own opId; the buttons are off meanwhile. A conflict reloads the list.
  const reorder = async (order, focusId) => {
    if (d.busy || order === d.order) return;
    d.busy = true;
    draw();
    try {
      const r = await api('PUT', '/api/inventory/era-order', { order, version: d.version }, { opId: newOpId() });
      Object.assign(d, { order: r.order, version: r.version, eras: [...d.eras].sort((a, b) => r.order.indexOf(a.era.slug) - r.order.indexOf(b.era.slug)), msg: 'Order saved.' });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'era-order-changed') return renderList(el, 'The order was changed by someone else. The list is reloaded.');
      d.msg = err.code === 'catalog-busy' ? 'Busy, try again.' : `Order not saved: ${err.message}`;
    }
    d.busy = false;
    draw();
    if (focusId) document.getElementById(focusId)?.focus();
  };
  d.msg = msg;
  draw();
  root.addEventListener('click', e => {
    const b = e.target.closest('[data-move]');
    if (!b) return;
    const i = d.eras.findIndex(x => x.era.slug === b.dataset.move), dir = Number(b.dataset.d);
    reorder(moveSlug(d.order, b.dataset.move, dir), reorderFocus('er', i, dir, d.eras.length));
  });
  let from = null;
  root.addEventListener('dragstart', e => { from = e.target.closest?.('.era')?.dataset.slug ?? null; if (from) { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', from); } });
  root.addEventListener('dragover', e => { if (from && e.target.closest?.('.era')) e.preventDefault(); });
  root.addEventListener('drop', e => {
    const to = e.target.closest?.('.era')?.dataset.slug;
    if (!from || !to) return;
    e.preventDefault();
    const rest = d.order.filter(s => s !== from);
    const at = d.order.indexOf(to);
    rest.splice(at, 0, from);
    from = null;
    reorder(rest);
  });
}

// ---- One era ----

const field = (label, id, input) => `<div class="field"><label for="${id}">${label}</label>${input}</div>`;

function pageHtml(st, owner) {
  const e = st.edited, off = owner ? '' : ' disabled';
  const conflict = st.conflict && changedEraFields(st.original, st.conflict.current).map(f => FIELDS[f]).join(', ');
  return `<a class="pp__back" href="#inventory/eras">‹ Eras</a>
    ${conflict ? `<div class="pp__conflict" role="alert">
      <p>Someone else saved this era since you opened it. Changed: ${esc(conflict)}. Your edits are still here.</p>
      <button type="button" class="btn" data-act="mine">Use mine</button> <button type="button" class="btn btn--line" data-act="discard">Discard mine</button>
    </div>` : ''}
    <div class="pp__head"><h1 class="pp__title">${st.isNew ? 'New era' : esc(st.original.name)}</h1></div>
    <section class="card" aria-labelledby="h-era"><h2 class="card__title" id="h-era">Details</h2>
      ${field('Name', 'e-name', `<input id="e-name" name="name" maxlength="100" value="${esc(e.name)}"${off}>`)}
      ${st.isNew ? field('Address <small>in the web address; fixed once saved</small>', 'e-slug', `<input id="e-slug" name="slug" maxlength="60" value="${esc(e.slug)}" autocapitalize="off" autocomplete="off" spellcheck="false">`) : ''}
      ${field('Tagline', 'e-tagline', `<input id="e-tagline" name="tagline" maxlength="200" value="${esc(e.tagline)}"${off}>`)}
      ${field('Story', 'e-story', `<textarea id="e-story" name="story" maxlength="5000" rows="6"${off}>${esc(e.story)}</textarea>`)}
      <div class="two">
        ${field('Drops at', 'e-drops', `<input id="e-drops" name="dropsAt" type="datetime-local" value="${esc(toLocal(e.dropsAt))}"${off}>`)}
        ${field('Ends at', 'e-ends', `<input id="e-ends" name="endsAt" type="datetime-local" value="${esc(toLocal(e.endsAt))}"${off}>`)}
      </div>
      ${field('Status', 'e-state', `<select id="e-state" name="state"${off}>${[['draft', 'Draft'], ['published', 'Published'], ['archived', 'Archived']]
        .map(([k, v]) => `<option value="${k}"${e.state === k ? ' selected' : ''}>${v}</option>`).join('')}</select>`)}
      <p class="note">Publishing needs a tagline, a story and a hero photo.</p>
    </section>
    <section class="card" aria-labelledby="h-hero"><h2 class="card__title" id="h-hero">Hero photo</h2>
      <div class="card__body">
        ${e.hero ? `<img class="era__hero" ${imageAttrs(photoPath(e.hero), '(min-width: 768px) 480px, 90vw')} alt="Hero photo for ${esc(e.name || 'this era')}">` : '<p class="note">No hero photo yet.</p>'}
        ${owner ? `<label class="btn btn--line photos__add" for="e-hero">${e.hero ? 'Replace hero photo' : '+ Hero photo'}</label>
          <input id="e-hero" class="photos__file" type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif" aria-label="${e.hero ? 'Replace' : 'Add'} hero photo">
          ${e.hero ? '<button type="button" class="btn btn--line" id="e-hero-del">Remove hero photo</button>' : ''}` : ''}
      </div>
    </section>
    ${owner ? '<div class="savebar" hidden><p class="savebar__text" id="savebar-text" aria-live="polite"></p><button type="button" class="btn" id="save">Save</button></div>' : ''}`;
}

function refreshBar(st) {
  const bar = st.el.querySelector('.savebar');
  if (!bar) return;
  const n = changedEraFields(st.original, st.edited);
  const text = n.length ? `Unsaved: ${n.map(f => FIELDS[f]).join(', ')}` : '';
  bar.hidden = !text && !st.msg;
  bar.querySelector('.savebar__text').textContent = st.msg || text;
  const b = bar.querySelector('#save');
  b.disabled = st.saving || !!st.uploading || !text;
  b.textContent = st.saving ? 'Saving…' : 'Save';
}

function draw(st) {
  const id = document.activeElement?.id;
  const root = Object.assign(document.createElement('div'), { className: 'pp' });
  root.innerHTML = pageHtml(st, st.owner);
  st.el.replaceChildren(root);
  for (const c of st.fieldErrors) root.querySelector(`[name="${{ 'name-invalid': 'name', 'slug-invalid': 'slug', 'era-exists': 'slug', 'tagline-invalid': 'tagline', 'tagline-required': 'tagline', 'story-invalid': 'story', 'story-required': 'story' }[c]}"]`)?.setAttribute('aria-invalid', 'true');
  refreshBar(st);
  if (st.saving) for (const c of root.querySelectorAll('input, select, textarea, button')) c.disabled = true;
  root.addEventListener('input', e => onInput(st, e));
  root.addEventListener('change', e => onChange(st, e));
  root.addEventListener('click', e => onClick(st, e));
  if (id) document.getElementById(id)?.focus({ preventScroll: true });
}

const DATES = { dropsAt: 1, endsAt: 1 };
function onInput(st, e) {
  const t = e.target, { edited } = st;
  if (!Object.hasOwn(FIELDS, t.name) && t.name !== 'slug') return;
  edited[t.name] = DATES[t.name] ? fromLocal(t.value) : t.value;
  if (t.name === 'name' && st.isNew && !st.slugTouched) st.el.querySelector('#e-slug').value = edited.slug = slugify(t.value);
  if (t.name === 'slug') st.slugTouched = true;
  t.removeAttribute('aria-invalid');
  st.msg = '';
  refreshBar(st);
}

async function onChange(st, e) {
  const t = e.target;
  if (t.name === 'state') { st.edited.state = t.value; st.msg = ''; return refreshBar(st); }
  if (t.id !== 'e-hero' || !t.files[0]) return;
  const file = t.files[0];
  t.value = '';
  if (st.saving || st.uploading) return;
  st.uploading = 1;
  t.disabled = true; // one upload at a time
  st.msg = 'Uploading the hero photo…';
  refreshBar(st);
  try {
    const ref = await uploadPhoto(file);
    st.edited.hero = ref; // set once it lands, on the era as it is by then
    st.msg = '';
  } catch (err) {
    st.msg = `${file.name}: ${err.status === 413 ? 'This photo is too large to upload.' : err.message}`;
  }
  st.uploading = 0;
  if (state === st) draw(st);
}

function onClick(st, e) {
  const t = e.target.closest('button');
  if (!t || st.saving) return;
  if (st.uploading && t.dataset.act !== 'discard') { st.msg = uploadBlock(st); return refreshBar(st); }
  if (t.id === 'save') save(st);
  else if (t.id === 'e-hero-del') { st.edited.hero = null; st.msg = ''; draw(st); } else if (t.dataset.act === 'discard') { state = null; load(st.el, st.slug); } else if (t.dataset.act === 'mine') {
    // Fields this owner didn't touch take the other version; then it saves on top of it.
    const { current, version } = st.conflict, mine = changedEraFields(st.original, st.edited);
    for (const f of Object.keys(FIELDS)) if (!mine.includes(f)) st.edited[f] = current[f];
    Object.assign(st, { original: current, version, conflict: null });
    save(st);
  }
}

async function save(st) {
  if (st.saving || st.uploading) return;
  if (st.isNew && (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(st.edited.slug) || st.edited.slug === 'new')) { // 'new' is the create page's address
    Object.assign(st, { fieldErrors: ['slug-invalid'], msg: `Not saved: ${ERRORS['slug-invalid']}` });
    return draw(st);
  }
  Object.assign(st, { saving: true, msg: '', fieldErrors: [] });
  draw(st);
  const slug = st.isNew ? st.edited.slug : st.slug;
  const body = { era: { ...st.edited, slug, name: st.edited.name.trim() }, version: st.version };
  const key = JSON.stringify([slug, body]);
  if (st.op?.key !== key) st.op = { key, id: newOpId() }; // pressing Save again after a lost reply resends the same op
  let created = null;
  try {
    const r = await api('PUT', `/api/inventory/eras/${encodeURIComponent(slug)}`, body, { opId: st.op.id });
    st.op = null;
    Object.assign(st, { original: r.era, edited: structuredClone(r.era), version: r.version, conflict: null, msg: 'Saved.' });
    if (st.isNew) created = slug;
  } catch (err) {
    if (err.status && err.status < 500) st.op = null; // the server answered: this op will not land
    if (err.code === 'era-changed' && err.details?.current) st.conflict = err.details;
    st.fieldErrors = err.code === 'invalid-era' ? err.details?.errors ?? [] : [err.code];
    st.msg = `Not saved: ${errorText(err)}`;
  }
  st.saving = false;
  if (state !== st) return;
  if (created) { state = null; location.hash = `#inventory/eras/${encodeURIComponent(created)}`; return; }
  draw(st);
}

async function load(el, slug) {
  const owner = staff()?.role === 'owner', isNew = slug === 'new';
  if (isNew && !owner) return setMessage(el, 'Only owners can add eras.');
  const root = Object.assign(document.createElement('div'), { className: 'pp' });
  setMessage(root, 'Loading…');
  el.replaceChildren(root);
  try {
    const d = await api('GET', '/api/inventory/eras');
    if (!root.isConnected) return;
    registerImages(d.media);
    const found = d.eras.find(x => x.era.slug === slug);
    if (!isNew && !found) return setMessage(root, 'No era with that address.');
    const era = found?.era ?? blank();
    state = { el, slug, isNew, owner, email: staff()?.email, original: era, edited: structuredClone(era), version: isNew ? null : found.version, conflict: null, msg: '', fieldErrors: [], saving: false, uploading: 0, slugTouched: false, op: null };
    draw(state);
  } catch (err) {
    if (root.isConnected) setMessage(root, err.message, () => load(el, slug));
  }
}

// `params` follows 'eras' in the address: [] for the list, [slug] for one era.
export function render(el, params, who) {
  staff = () => who;
  if (resumes(state, params[0], who?.email)) { state.el = el; return draw(state); } // back from the sign-in screen
  state = null;
  return params[0] ? load(el, params[0]) : renderList(el);
}
