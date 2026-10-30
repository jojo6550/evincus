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
    draw: bitmap => ctx.drawImage(bitmap, 0, 0, w, h),
    blob: (type, quality) => (off ? canvas.convertToBlob({ type, quality }) : new Promise(resolve => canvas.toBlob(resolve, type, quality))),
  };
};

const QUALITIES = [0, 1, 2, 3, 4, 5].map(i => Math.round((0.82 - 0.06 * i) * 100) / 100); // 0.82 down to 0.52, above the 0.5 floor

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
        canvas.draw(bitmap);
        let blob = null;
        for (const q of QUALITIES) {
          const b = await canvas.blob(type, q);
          if (b?.type !== type) return null; // Safari answers a WebP request with PNG
          if (b.size <= MAX_VARIANT_BYTES) { blob = b; break; }
        }
        if (!blob) throw new PhotoError('photo-too-large', 'This photo is too large even after shrinking it. Try a smaller photo.');
        out.push(blob);
      }
      return out;
    };
    const out = await attempt('image/webp') ?? await attempt('image/jpeg');
    if (!out) throw new PhotoError('photo-unreadable', "This photo format can't be read here. Try a JPEG.");
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

// ---- Photo lists: `key` is 'all' (the product's own images) or a colour's row index ----

export const photoList = (p, key) => (key === 'all' ? p.images : p.colors[key].images) ?? [];
export function setPhotos(p, key, list) {
  if (key === 'all') p.images = list; else p.colors[key].images = list;
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
  ...p.colors.map((c, i) => ({ key: String(i), name: c.name || 'New colour', c })),
];

const WHY = { 'invalid-photo': "The server couldn't read this photo. Try a JPEG." };
const why = err => WHY[err.code] ?? (err.status === 413 ? 'This photo is too large to upload.' : err.message);
const SIZES = '(min-width: 1024px) 110px, 22vw';

// ---- UI ----

function groupHtml(p, g, pg) {
  const list = photoList(p, g.key);
  const edit = pg.owner;
  const items = list.map((r, i) => `<li class="photo" data-i="${i}"${edit ? ' draggable="true"' : ''}>
      <img ${imageAttrs(photoPath(r), SIZES)} alt="${esc(`${g.name} photo ${i + 1}`)}" loading="lazy" draggable="false">
      ${i === 0 ? '<span class="tag photo__cover">COVER</span>' : ''}
      ${edit ? `<span class="photo__bar">
        <button type="button" id="ph-up-${i}" data-pmove="${i}" data-d="-1" aria-label="Move ${esc(g.name)} photo ${i + 1} earlier"${i === 0 ? ' disabled' : ''}>‹</button>
        <button type="button" id="ph-dn-${i}" data-pmove="${i}" data-d="1" aria-label="Move ${esc(g.name)} photo ${i + 1} later"${i === list.length - 1 ? ' disabled' : ''}>›</button>
        <button type="button" id="ph-del-${i}" data-pdel="${i}" aria-label="Remove ${esc(g.name)} photo ${i + 1}">×</button>
      </span>` : ''}
    </li>`).join('');
  return `<h3 class="group">${g.c ? swatch(g.c) : ''}${esc(g.name)}</h3>
    <ul class="photos" aria-label="${esc(g.name)} photos">${items || '<li class="note">No photos yet.</li>'}</ul>`;
}

export function photosHtml(pg) {
  const p = pg.edited, groups = groupsOf(p);
  if (!pg.owner) return groups.map(g => groupHtml(p, g, pg)).join('');
  const g = groups.find(x => x.key === pg.photoTab) ?? groups[0];
  const tabs = groups.map(x => `<button type="button" class="chip" data-ptab="${x.key}" aria-pressed="${x === g}">${esc(x.name)} <em>${photoList(p, x.key).length}</em></button>`).join('');
  return `<div class="chips" role="group" aria-label="Photos for">${tabs}</div>
    ${groupHtml(p, g, pg)}
    <label class="btn btn--line photos__add" for="ph-file">+ Photos for ${esc(g.name)}</label>
    <input id="ph-file" class="photos__file" type="file" multiple accept="image/jpeg,image/png,image/webp,image/heic,image/heif" aria-label="Add photos for ${esc(g.name)}" data-key="${g.key}">
    <p class="note" id="photo-msg" role="status">${esc(pg.photoMsg ?? '')}</p>
    <p class="note">Drag a photo, or use the arrows, to reorder. The first is the cover.</p>`;
}

// Wires the uploader inside `root`. `getPage` is the open page's state; `edited()` runs after a change to its photos.
export function wirePhotos(root, getPage, edited) {
  const body = () => root.querySelector('#photos-body');
  const redraw = () => {
    const pg = getPage(), el = body(), id = document.activeElement?.id;
    if (!pg || !el?.isConnected) return;
    el.innerHTML = photosHtml(pg);
    if (id) document.getElementById(id)?.focus({ preventScroll: true });
  };
  const change = (pg, key, list) => {
    setPhotos(pg.edited, key, list);
    pg.msg = '';
    redraw();
    edited();
  };
  const activeKey = pg => (groupsOf(pg.edited).find(x => x.key === pg.photoTab) ?? groupsOf(pg.edited)[0]).key;

  root.addEventListener('click', e => {
    const pg = getPage(), t = e.target.closest('button');
    if (!t || !body()?.contains(t)) return;
    const key = activeKey(pg), list = photoList(pg.edited, key);
    if (t.dataset.ptab) { pg.photoTab = t.dataset.ptab; redraw(); } else if (t.dataset.pmove) {
      const i = Number(t.dataset.pmove);
      change(pg, key, moveTo(list, i, i + Number(t.dataset.d)));
    } else if (t.dataset.pdel) {
      const i = Number(t.dataset.pdel);
      change(pg, key, removeAt(list, i));
      document.getElementById(`ph-del-${Math.min(i, list.length - 2)}`)?.focus();
    }
  });

  root.addEventListener('change', async e => {
    const input = e.target, pg = getPage();
    if (input.id !== 'ph-file' || !pg) return;
    const files = [...input.files], key = input.dataset.key;
    input.value = '';
    pg.uploading = (pg.uploading ?? 0) + 1;
    const problems = [];
    edited(); // Save waits for the uploads
    for (const [n, file] of files.entries()) {
      pg.photoMsg = `Uploading ${n + 1} of ${files.length}…`;
      redraw();
      try {
        setPhotos(pg.edited, key, [...photoList(pg.edited, key), await uploadPhoto(file)]);
      } catch (err) {
        problems.push(`${file.name}: ${why(err)}`);
      }
    }
    pg.uploading--;
    pg.photoMsg = problems.join(' ');
    redraw();
    edited();
  });

  // Drag to reorder: the dragged photo lands where it is dropped.
  let from = -1;
  root.addEventListener('dragstart', e => {
    const li = e.target.closest?.('.photo');
    if (!li) return;
    from = Number(li.dataset.i);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(from));
  });
  root.addEventListener('dragover', e => { if (from >= 0 && e.target.closest?.('.photo')) e.preventDefault(); });
  root.addEventListener('drop', e => {
    const li = e.target.closest?.('.photo'), pg = getPage();
    if (!li || from < 0 || !pg) return;
    e.preventDefault();
    const key = activeKey(pg);
    change(pg, key, moveTo(photoList(pg.edited, key), from, Number(li.dataset.i)));
    from = -1;
  });
  root.addEventListener('dragend', () => { from = -1; });
}
