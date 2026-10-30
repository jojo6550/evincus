// Product photos on the inventory page: browser-side conversion to responsive variants, upload, and the per-colour
// uploader. The helpers above the UI are pure (or take injected fakes) and exported for tests.
import { api } from './inventory-api.js';
import { registerImages, imageAttrs } from './images.js';
import { variantWidths, MAX_VARIANT_BYTES, photoPath, manifestEntry } from '../../data/photos.js';
import { esc, swatch } from './inventory-products-view.js';

class PhotoError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// Draws on a canvas of the given size; OffscreenCanvas where the browser has it, else a detached <canvas>.
const defaultCanvas = (w, h) => {
  const off = !!globalThis.OffscreenCanvas;
  const canvas = off ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  return {
    draw: (bitmap, fill) => {
      if (fill) { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h); } // JPEG has no alpha: a transparent PNG would turn black
      ctx.drawImage(bitmap, 0, 0, w, h);
    },
    blob: (type, quality) => (off ? canvas.convertToBlob({ type, quality }) : new Promise(resolve => canvas.toBlob(resolve, type, quality))),
  };
};

const QUALITIES = [0.82, 0.76, 0.7, 0.64, 0.58, 0.52, 0.5]; // steps of 0.06 down to the 0.5 floor

// -> Blob[] (one per width, all `image/webp` or all `image/jpeg`), each ≤ MAX_VARIANT_BYTES. Never the original file.
export async function encodeVariants(file, { createImageBitmap = globalThis.createImageBitmap?.bind(globalThis), makeCanvas = defaultCanvas } = {}) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new PhotoError('photo-unreadable', "This photo format can't be read here. Try a JPEG.");
  }
  try {
    const attempt = async type => {
      const out = [];
      for (const w of variantWidths(bitmap.width)) {
        const canvas = makeCanvas(w, Math.max(1, Math.round(bitmap.height * w / bitmap.width)));
        canvas.draw(bitmap, type === 'image/jpeg');
        let blob = null;
        for (const q of QUALITIES) {
          const b = await canvas.blob(type, q);
          if (!b) throw new PhotoError('photo-unprocessed', "This photo couldn't be processed here. Try a smaller photo.");
          if (b.type !== type) return null; // Safari answers a WebP request with PNG
          if (b.size <= MAX_VARIANT_BYTES) { blob = b; break; }
        }
        if (!blob) throw new PhotoError('photo-too-large', 'This photo is too large even after shrinking it. Try a smaller photo.');
        out.push(blob);
      }
      return out;
    };
    const out = await attempt('image/webp') ?? await attempt('image/jpeg');
    if (!out) throw new PhotoError('photo-unprocessed', "This photo couldn't be processed here. Try a smaller photo.");
    return out;
  } finally {
    bitmap.close?.();
  }
}

// -> the photo ref the server stores. The file is converted here; only the variants go up.
export async function uploadPhoto(file, deps) {
  const form = new FormData();
  for (const [i, blob] of (await encodeVariants(file, deps)).entries()) form.append('file', blob, `v${i}.${blob.type === 'image/webp' ? 'webp' : 'jpg'}`);
  const ref = await api('PUT', '/api/inventory/media', form, { timeout: 120000 });
  registerImages({ [photoPath(ref)]: manifestEntry(ref) });
  return ref;
}

// ---- Photo lists: `key` is 'all' (the product's own images) or a colour row's rowKey ----

// A colour row is known by its loaded name (`from`) or the tmp key of a new row. Unlike an index, that survives other
// rows being added or removed while a photo uploads.
export const rowKey = c => c.from ?? c.tmp;
const colorOf = (p, key) => p.colors.find(c => rowKey(c) === key);
// null when that colour row is gone
export const photoList = (p, key) => (key === 'all' ? p.images ?? [] : colorOf(p, key) ? colorOf(p, key).images ?? [] : null);
export function setPhotos(p, key, list) {
  if (key === 'all') p.images = list;
  else if (colorOf(p, key)) colorOf(p, key).images = list;
  else return false;
  return true;
}
export function moveTo(list, from, to) {
  if (from === to || to < 0 || to >= list.length || from < 0 || from >= list.length) return list;
  const out = [...list];
  out.splice(to, 0, out.splice(from, 1)[0]);
  return out;
}
export const removeAt = (list, i) => list.filter((_, j) => j !== i);

// The groups the page offers: the all-colours list when the product has one (or no colours yet), then each colour.
export const groupsOf = p => [
  ...(p.images !== undefined || !p.colors.length ? [{ key: 'all', name: 'All colours' }] : []),
  ...p.colors.map(c => ({ key: rowKey(c), name: c.name || 'New colour', c })),
];

const WHY = { 'invalid-photo': "The server couldn't read this photo. Try a JPEG." };
const why = err => WHY[err.code] ?? (err.status === 413 ? 'This photo is too large to upload.' : err.message);

// Adds an uploaded photo to the list as it is when the upload lands, so edits made meanwhile stay. A colour removed
// meanwhile leaves the photo in `pg.unattached`. -> '' or a notice; never throws.
export async function addFile(pg, key, file, upload = uploadPhoto) {
  try {
    const ref = await upload(file);
    const list = photoList(pg.edited, key);
    if (list && setPhotos(pg.edited, key, [...list, ref])) return '';
    (pg.unattached ??= []).push({ name: file.name, ref });
    return `${file.name}: its colour was removed while it uploaded, so the photo isn’t attached.`;
  } catch (err) {
    return `${file.name}: ${why(err)}`;
  }
}
// While a photo uploads, Use mine and the other saves wait: they would rebase or replace the edits it lands on.
export const uploadBlock = pg => (pg.uploading ? 'Wait for the photo upload to finish.' : '');

// The control to focus after moving item `from` by `d` in a list of `len`: the same arrow on the item's new place, or
// the other arrow when it reached that end (its own is disabled there). The ids are `prefix`-up-N and `prefix`-dn-N.
export function reorderFocus(prefix, from, d, len) {
  const to = from + d;
  const atEnd = d < 0 ? to === 0 : to === len - 1;
  return `${prefix}-${(d < 0) !== atEnd ? 'up' : 'dn'}-${to}`;
}

// ---- UI ----

const SIZES = '(min-width: 1024px) 110px, 22vw';

function groupHtml(p, g, pg) {
  const list = photoList(p, g.key);
  const edit = pg.owner;
  const items = list.map((r, i) => `<li class="photo" data-i="${i}"${edit ? ' draggable="true"' : ''}>
      <img ${imageAttrs(photoPath(r), SIZES)} alt="${esc(`${g.name} photo ${i + 1}`)}" loading="lazy" draggable="false">
      ${i === 0 ? '<span class="tag photo__cover">COVER</span>' : ''}
      ${edit ? `<span class="photo__bar">
        <button type="button" id="ph-up-${i}" data-pmove="${i}" data-d="-1" aria-label="Move ${esc(g.name)} photo ${i + 1} of ${list.length} earlier"${i === 0 ? ' disabled' : ''}>‹</button>
        <button type="button" id="ph-dn-${i}" data-pmove="${i}" data-d="1" aria-label="Move ${esc(g.name)} photo ${i + 1} of ${list.length} later"${i === list.length - 1 ? ' disabled' : ''}>›</button>
        <button type="button" id="ph-del-${i}" data-pdel="${i}" aria-label="Remove ${esc(g.name)} photo ${i + 1} of ${list.length}">×</button>
      </span>` : ''}
    </li>`).join('');
  return `<h3 class="group">${g.c ? swatch(g.c) : ''}${esc(g.name)}</h3>
    <ul class="photos" aria-label="${esc(g.name)} photos">${items || '<li class="note">No photos yet.</li>'}</ul>`;
}

export function photosHtml(pg) {
  const p = pg.edited, groups = groupsOf(p);
  if (!pg.owner) return groups.map(g => groupHtml(p, g, pg)).join('');
  const g = groups.find(x => x.key === pg.photoTab) ?? groups[0];
  const tabs = groups.map(x => `<button type="button" class="chip" data-ptab="${esc(x.key)}" aria-pressed="${x === g}">${esc(x.name)} <em>${photoList(p, x.key).length}</em></button>`).join('');
  const off = pg.uploading ? ' disabled' : '';
  const loose = (pg.unattached ?? []).map((u, i) => `<p class="note">Not attached: ${esc(u.name)} (its colour was removed while it uploaded). <button type="button" class="btn btn--line" data-pattach="${i}">Add to ${esc(g.name)}</button></p>`).join('');
  return `<div class="chips" role="group" aria-label="Photos for">${tabs}</div>
    ${groupHtml(p, g, pg)}
    <label class="btn btn--line photos__add" for="ph-file">+ Photos for ${esc(g.name)}</label>
    <input id="ph-file" class="photos__file" type="file" multiple accept="image/jpeg,image/png,image/webp,image/heic,image/heif" aria-label="Add photos for ${esc(g.name)}" data-key="${esc(g.key)}"${off}>
    <p class="note" id="photo-msg" role="status">${esc(pg.photoMsg ?? '')}</p>
    ${loose}
    <p class="note">Drag a photo, or use the arrows, to reorder. The first is the cover.</p>`;
}

// Wires the uploader inside `root`. `getPage` is the open page's state; `edited()` runs after a change to its photos.
// Everything finds the page and its root through `getPage()` when it runs, so an upload that lands after the page was
// redrawn, or left, still does the right thing.
export function wirePhotos(root, getPage, edited) {
  const redraw = pg => {
    if (getPage() !== pg) return;
    const el = pg.el.querySelector('#photos-body'), id = document.activeElement?.id;
    if (!el) return;
    el.innerHTML = photosHtml(pg);
    if (id) document.getElementById(id)?.focus({ preventScroll: true });
  };
  const changed = pg => { if (getPage() === pg) edited(); };
  const change = (pg, key, list, focusId) => {
    setPhotos(pg.edited, key, list);
    pg.msg = '';
    redraw(pg);
    if (focusId) (document.getElementById(focusId) ?? document.getElementById('ph-file'))?.focus();
    changed(pg);
  };
  const activeKey = pg => (groupsOf(pg.edited).find(x => x.key === pg.photoTab) ?? groupsOf(pg.edited)[0]).key;

  root.addEventListener('click', e => {
    const pg = getPage(), t = e.target.closest('button');
    if (!t || !pg || pg.saving || !pg.el.querySelector('#photos-body')?.contains(t)) return;
    const key = activeKey(pg), list = photoList(pg.edited, key);
    if (t.dataset.ptab) { pg.photoTab = t.dataset.ptab; redraw(pg); } else if (t.dataset.pmove) {
      const i = Number(t.dataset.pmove), d = Number(t.dataset.d);
      if (i + d < 0 || i + d >= list.length) return;
      change(pg, key, moveTo(list, i, i + d), reorderFocus('ph', i, d, list.length));
    } else if (t.dataset.pdel) {
      const i = Number(t.dataset.pdel);
      change(pg, key, removeAt(list, i), `ph-del-${Math.min(i, list.length - 2)}`);
    } else if (t.dataset.pattach) {
      const [u] = pg.unattached.splice(Number(t.dataset.pattach), 1);
      change(pg, key, [...list, u.ref]);
    }
  });

  root.addEventListener('change', async e => {
    const input = e.target, pg = getPage();
    if (input.id !== 'ph-file' || !pg) return;
    const files = [...input.files], key = input.dataset.key;
    input.value = '';
    if (pg.saving || pg.uploading || !files.length) return; // one batch at a time, and none while a save runs
    pg.uploading = 1;
    const problems = [];
    for (const [n, file] of files.entries()) {
      pg.photoMsg = `Uploading ${n + 1} of ${files.length}…`;
      redraw(pg);
      changed(pg); // Save waits for the uploads
      const problem = await addFile(pg, key, file);
      if (problem) problems.push(problem);
    }
    pg.uploading = 0;
    pg.photoMsg = problems.join(' ');
    redraw(pg);
    changed(pg);
  });

  // Drag to reorder: the dragged photo lands where it is dropped.
  let from = -1;
  root.addEventListener('dragstart', e => {
    const li = e.target.closest?.('.photo');
    if (!li || getPage()?.saving) return;
    from = Number(li.dataset.i);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(from));
  });
  root.addEventListener('dragover', e => { if (from >= 0 && e.target.closest?.('.photo')) e.preventDefault(); });
  root.addEventListener('drop', e => {
    const li = e.target.closest?.('.photo'), pg = getPage();
    if (!li || from < 0 || !pg || pg.saving) return;
    e.preventDefault();
    const key = activeKey(pg);
    change(pg, key, moveTo(photoList(pg.edited, key), from, Number(li.dataset.i)));
    from = -1;
  });
  root.addEventListener('dragend', () => { from = -1; });
}
