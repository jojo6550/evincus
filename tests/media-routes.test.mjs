import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { mkdtemp, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeEnv, callWithoutData, seedFromFixture, captureLogs, makeCtx } from './helpers/fake-env.mjs';
import { signIn, ADMIN_TOKEN } from './helpers/staff.mjs';
import { cleanMedia, mediaStore } from '../server/lib/media.js';
import { createApp } from '../server/index.js';
import { NOW } from './helpers/fixture.mjs';

const img = (w, h) => sharp({ create: { width: w, height: h, channels: 3, background: '#222' } }).webp().toBuffer();
const variants = () => Promise.all([480, 960].map(w => img(w, w * 5 / 4)));
// A multipart body as a browser builds it.
async function multipart(files, extra = {}) {
  const fd = new FormData();
  for (const f of files) fd.append('file', new Blob([f]), 'v.webp');
  for (const [k, v] of Object.entries(extra)) fd.append(k, v);
  const r = new Request('https://api.test/x', { method: 'POST', body: fd });
  return { raw: new Uint8Array(await r.arrayBuffer()), type: r.headers.get('content-type') };
}
const setup = async (role = 'owner') => {
  const env = makeEnv({ ADMIN_TOKEN });
  await seedFromFixture(env);
  return { env, cookie: await signIn(env, role) };
};
const put = async (env, cookie, files, path = '/api/inventory/media') => {
  const { raw, type } = await multipart(files);
  return callWithoutData('PUT', path, { env, raw, headers: { cookie, origin: 'https://api.test', 'content-type': type } });
};
const adminPut = async (env, files) => {
  const { raw, type } = await multipart(files);
  return callWithoutData('PUT', '/api/admin/media', { env, raw, headers: { Authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': type } });
};
const attach = (env, body) => callWithoutData('POST', '/api/admin/photos', { env, body, headers: { Authorization: `Bearer ${ADMIN_TOKEN}` } });

test('upload stores a variant set and returns its ref; a second identical upload is a no-op', async () => {
  const { env, cookie } = await setup();
  const logs = captureLogs();
  const a = await put(env, cookie, await variants());
  logs.restore();
  assert.equal(a.status, 200);
  assert.deepEqual(a.json.widths, [480, 960]);
  assert.equal(env.MEDIA.files.size, 2);
  assert.ok(JSON.stringify(logs.lines).includes("media.uploaded"));
  const b = await put(env, cookie, await variants());
  assert.deepEqual(b.json, a.json);
  assert.equal(env.MEDIA.files.size, 2);
  const c = await adminPut(env, await variants()); // the CLI route stores the same files
  assert.deepEqual(c.json, a.json);
});

test('upload refuses a photo while the disk is low, on both routes', async () => {
  const { env, cookie } = await setup();
  env.OPERATIONS = () => ({ disk: 'low', scheduler: 'ok' });
  const a = await put(env, cookie, await variants());
  assert.deepEqual([a.status, a.json.error.code], [507, 'disk-full']);
  const b = await adminPut(env, await variants());
  assert.deepEqual([b.status, b.json.error.code], [507, 'disk-full']);
  assert.equal(env.MEDIA.files.size, 0);
});

test('upload refuses > 1 MB, non-multipart, a PNG, a missing body and a viewer', async () => {
  const { env, cookie } = await setup();
  const big = await put(env, cookie, [new Uint8Array(1024 * 1024 + 1)]);
  assert.equal(big.status, 413);
  const plain = await callWithoutData('PUT', '/api/inventory/media', { env, body: { a: 1 }, headers: { cookie, origin: 'https://api.test' } });
  assert.deepEqual([plain.status, plain.json.error.code], [400, 'invalid-photo']);
  const none = await callWithoutData('PUT', '/api/inventory/media', { env, headers: { cookie, origin: 'https://api.test' } });
  assert.deepEqual([none.status, none.json.error.code], [400, 'invalid-photo']);
  const png = await sharp({ create: { width: 480, height: 600, channels: 3, background: '#222' } }).png().toBuffer();
  const p = await put(env, cookie, [png]);
  assert.deepEqual([p.status, p.json.error.code], [400, 'invalid-photo']);
  const viewer = await put(env, await signIn(env, 'viewer'), await variants());
  assert.equal(viewer.status, 403);
  assert.equal(env.MEDIA.files.size, 0);
  assert.equal((await callWithoutData('PUT', '/api/admin/media', { env })).status, 401);
});

test('the CLI photos endpoint attaches to a colour or sets the hero', async () => {
  const { env, cookie } = await setup();
  const { json: ref } = await put(env, cookie, await variants());
  const stored = key => JSON.parse(env.ORDERS.store.get(key).value);
  const colors = stored('product:alpha-tee').colors;
  const hasColorImages = colors.some(c => c.images);
  assert.ok(hasColorImages);
  const name = colors[0].name;
  const before = colors[0].images.length;
  const r = await attach(env, { era: 'alpha', target: 'alpha-tee', color: name, refs: [ref] });
  assert.equal(r.status, 200);
  assert.equal(stored('product:alpha-tee').colors[0].images.length, before + 1);
  assert.equal((await attach(env, { era: 'alpha', target: 'alpha-tee', color: name, refs: [ref] })).status, 200); // no duplicate
  assert.equal(stored('product:alpha-tee').colors[0].images.length, before + 1);
  const h = await attach(env, { era: 'alpha', target: 'hero', refs: [ref] });
  assert.equal(h.status, 200);
  assert.equal(stored('era:alpha').hero.id, ref.id);
  // refusals
  const code = async body => { const x = await attach(env, body); return [x.status, x.json.error.code]; };
  assert.deepEqual(await code({ era: 'alpha', target: 'alpha-tee', refs: [ref] }), [400, 'invalid-photo']); // colour required
  assert.deepEqual(await code({ era: 'alpha', target: 'alpha-tee', color: 'Nope', refs: [ref] }), [400, 'invalid-photo']);
  assert.deepEqual(await code({ era: 'alpha', target: 'alpha-tee', color: name, refs: [{ ...ref, id: 'f'.repeat(24) }] }), [400, 'invalid-photo']); // not uploaded
  assert.deepEqual(await code({ era: 'alpha', target: 'nope', refs: [ref] }), [404, 'unknown-product']);
  assert.deepEqual(await code({ era: 'old', target: 'alpha-tee', color: name, refs: [ref] }), [404, 'unknown-product']);
  assert.deepEqual(await code({ era: 'nope', target: 'hero', refs: [ref] }), [404, 'unknown-era']);
  assert.equal((await callWithoutData('POST', '/api/admin/photos', { env, body: {} })).status, 401);
});

test('the photos endpoint retries a lost version race', async () => {
  const { env, cookie } = await setup();
  const { json: ref } = await put(env, cookie, await variants());
  const real = env.ORDERS.getEntry.bind(env.ORDERS);
  let armed = true;
  env.ORDERS.getEntry = async k => {
    const e = await real(k);
    if (armed && k === 'era:alpha') { armed = false; await env.ORDERS.put(k, JSON.stringify({ ...JSON.parse(e.value), tagline: 'changed' })); }
    return e;
  };
  const h = await attach(env, { era: 'alpha', target: 'hero', refs: [ref] });
  assert.equal(h.status, 200);
  assert.equal(JSON.parse(env.ORDERS.store.get('era:alpha').value).tagline, 'changed');
});

test('cleanMedia removes only unreferenced files older than 24 hours, once per day', async () => {
  const { env, cookie } = await setup();
  const { json: ref } = await put(env, cookie, await variants());
  const orphan = n => `${String(n).padStart(24, '0')}-480.webp`;
  const DAY = 24 * 3600 * 1000;
  const now = new Date(NOW);
  const age = new Map([[orphan(90), +now - 2 * DAY], [orphan(91), +now - 1000]]);
  for (const n of age.keys()) await env.MEDIA.write(n, new Uint8Array(1));
  // a draft product's photo and an archived era's hero stay too
  await env.ORDERS.put('product:draft-x', JSON.stringify({ id: 'draft-x', era: 'alpha', status: 'draft', colors: [], images: [{ ...ref, id: '0'.repeat(23) + '9' }] }));
  await env.MEDIA.write(orphan(9), new Uint8Array(1));
  age.set(orphan(9), +now - 5 * DAY);
  const list = env.MEDIA.list.bind(env.MEDIA);
  env.MEDIA.list = async () => (await list()).map(f => ({ ...f, mtimeMs: age.get(f.name) ?? +now - 9 * DAY }));
  assert.equal(await cleanMedia(env, now), 3); // the orphan and the unattached upload's two files
  assert.equal(await env.MEDIA.has(orphan(90)), false);
  assert.equal(await env.MEDIA.has(orphan(91)), true);
  assert.equal(await env.MEDIA.has(orphan(9)), true);
  assert.equal(await env.MEDIA.has(`${ref.id}-480.webp`), false); // uploaded but never attached
});

test('cleanMedia keeps everything when a doc cannot be read', async () => {
  const { env } = await setup();
  await env.MEDIA.write(`${'a'.repeat(24)}-480.webp`, new Uint8Array(1));
  await env.ORDERS.put('product:broken', '{not json');
  const logs = captureLogs();
  assert.equal(await cleanMedia(env, new Date(NOW + 5 * 24 * 3600 * 1000)), 0);
  logs.restore();
  assert.equal(env.MEDIA.files.size, 1);
  assert.ok(JSON.stringify(logs.lines).includes('media.gc_skipped'));
});

test('scheduled runs the cleanup once per Jamaica day', async () => {
  const { env } = await setup();
  const file = `${'b'.repeat(24)}-480.webp`;
  await env.MEDIA.write(file, new Uint8Array(1));
  const run = async () => { const ctx = makeCtx(); await createApp({ clock: () => NOW }).scheduled({}, env, ctx); await ctx.settle(); };
  await run();
  assert.equal(await env.MEDIA.has(file), false);
  assert.ok(env.ORDERS.store.has('media-gc:' + new Date(NOW - 5 * 3600000).toISOString().slice(0, 10)));
  await env.MEDIA.write(file, new Uint8Array(1));
  await run();
  assert.equal(await env.MEDIA.has(file), true);
});

test('re-uploading an old orphan protects it from the next cleanup', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'media-'));
  try {
    const MEDIA = mediaStore(dir);
    const env = makeEnv({ MEDIA });
    const name = `${'c'.repeat(24)}-480.webp`;
    await MEDIA.write(name, new Uint8Array(1));
    const old = new Date(Date.now() - 3 * 24 * 3600 * 1000);
    await utimes(join(dir, name), old, old);
    await MEDIA.write(name, new Uint8Array(1));
    assert.equal(await cleanMedia(env, new Date()), 0);
    assert.equal(await MEDIA.has(name), true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
