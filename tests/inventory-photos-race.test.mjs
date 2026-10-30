import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { encodeVariants, uploadPhoto, addFile, uploadBlock, reorderFocus, photoList, setPhotos, removeAt } from '../assets/js/inventory-photos.js';
import { resumes } from '../assets/js/inventory-eras.js';
import { editable, mergeMine } from '../assets/js/inventory-products.js';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const REF = { id: 'a'.repeat(24), width: 3000, height: 2000, widths: [480, 960, 1440], ext: 'webp' };
const ref = id => ({ ...REF, id: id.repeat(24) });
const page = () => ({ edited: { images: undefined, colors: [{ name: 'Red', from: 'Red', images: [ref('1')] }, { name: 'Blue', from: 'Blue' }] } });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test('uploadPhoto sends one file part per width and never the original file', async () => {
  let form;
  globalThis.fetch = async (url, init) => { form = init.body; return new Response(JSON.stringify(REF), { status: 200, headers: { 'Content-Type': 'application/json' } }); };
  const original = new Blob(['original'], { type: 'image/png' });
  const deps = {
    createImageBitmap: async () => ({ width: 3000, height: 2000 }),
    makeCanvas: () => ({ draw() {}, blob: async type => new Blob(['x'], { type }) }),
  };
  assert.deepEqual(await uploadPhoto(original, deps), REF);
  assert.ok(form instanceof FormData);
  const parts = form.getAll('file');
  assert.equal(parts.length, 3);
  for (const part of parts) assert.equal(await part.text(), 'x');
});

test('encodeVariants fills white under JPEG only, and says so when the canvas gives no blob', async () => {
  const draws = [];
  const deps = { createImageBitmap: async () => ({ width: 480, height: 480 }) };
  await encodeVariants({}, { ...deps, makeCanvas: () => ({ draw: (b, fill) => draws.push(fill), blob: async type => ({ type: type === 'image/webp' ? 'image/png' : type, size: 1 }) }) });
  assert.deepEqual(draws, [false, true]); // the WebP try, then the JPEG one
  await assert.rejects(encodeVariants({}, { ...deps, makeCanvas: () => ({ draw() {}, blob: async () => null }) }),
    e => e.message === "This photo couldn't be processed here. Try a smaller photo.");
});

test('a photo that lands after other edits is added to the list as it is by then', async () => {
  const pg = page();
  const up = deferred();
  const adding = addFile(pg, 'Red', { name: 'a.jpg' }, () => up.promise);
  setPhotos(pg.edited, 'Red', removeAt(photoList(pg.edited, 'Red'), 0)); // removed during the upload
  setPhotos(pg.edited, 'Red', [...photoList(pg.edited, 'Red'), ref('2')]); // and another added
  up.resolve(ref('3'));
  assert.equal(await adding, '');
  assert.deepEqual(photoList(pg.edited, 'Red').map(r => r.id[0]), ['2', '3']);
});

test('a photo for a colour removed during the upload is kept as not attached, and nothing throws', async () => {
  const pg = page();
  const up = deferred();
  const adding = addFile(pg, 'Blue', { name: 'b.jpg' }, () => up.promise);
  pg.edited.colors.splice(1, 1);
  up.resolve(ref('4'));
  assert.match(await adding, /^b\.jpg: .*colour was removed/);
  assert.deepEqual(pg.unattached.map(u => [u.name, u.ref.id[0]]), [['b.jpg', '4']]);
  assert.match(await addFile(pg, 'Red', { name: 'c.jpg' }, async () => { throw Object.assign(new Error('boom'), { status: 500 }); }), /^c\.jpg: boom/);
});

test('Use mine and saves wait while a photo uploads', () => {
  assert.match(uploadBlock({ uploading: 1 }), /Wait for the photo upload/);
  assert.equal(uploadBlock({ uploading: 0 }), '');
});

test('keyboard reorder keeps focus on the moved item, or the other arrow at the end of the list', () => {
  assert.equal(reorderFocus('ph', 2, -1, 4), 'ph-up-1');
  assert.equal(reorderFocus('ph', 1, -1, 4), 'ph-dn-0');
  assert.equal(reorderFocus('ph', 1, 1, 4), 'ph-dn-2');
  assert.equal(reorderFocus('er', 2, 1, 4), 'er-up-3');
});

test('an era page resumes for the same era and account, only while it has unsaved edits', () => {
  const era = { slug: 'a', name: 'A', tagline: '', story: '', hero: null, dropsAt: null, endsAt: null, state: 'draft' };
  const st = { slug: 'a', email: 'o@x.com', original: era, edited: { ...era, name: 'B' } };
  assert.equal(resumes(st, 'a', 'o@x.com'), true);
  assert.equal(resumes(st, 'a', 'other@x.com'), false);
  assert.equal(resumes(st, 'b', 'o@x.com'), false);
  assert.equal(resumes({ ...st, edited: era }, 'a', 'o@x.com'), false);
  assert.equal(resumes(null, 'a', 'o@x.com'), false);
});

test('Use mine merges photos by colour row, not by position', () => {
  const base = { id: 'p', era: 'e', status: 'draft', name: 'P', sizes: ['M'], skus: {} };
  const original = { ...base, colors: [{ name: 'Red', hex: '#ff0000' }, { name: 'Blue', hex: '#0000ff', images: [ref('b')] }] };
  const edited = editable(original);
  edited.colors[1].images = [...edited.colors[1].images, ref('n')]; // mine: a photo on Blue
  // theirs: the colours were reordered and Red got a photo
  const current = { ...base, colors: [{ name: 'Blue', hex: '#0000ff', images: [ref('b')] }, { name: 'Red', hex: '#ff0000', images: [ref('r')] }] };
  mergeMine(original, edited, current);
  assert.deepEqual(edited.colors.map(c => [c.name, c.images.map(r => r.id[0]).join('')]), [['Blue', 'bn'], ['Red', 'r']]);
});
