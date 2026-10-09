import test from 'node:test';
import assert from 'node:assert/strict';
import { skip, memoryKv } from './helpers/deno-kv.mjs';
import { kvStore, CHUNK } from '../server/lib/kv-store.js';

async function open(t) {
  const kv = await memoryKv(t);
  const clock = { t: Date.parse('2026-10-03T12:00:00Z') };
  return { kv, clock, s: kvStore(kv, { now: () => clock.t }) };
}

async function raw(kv, prefix) {
  const out = [];
  for await (const e of kv.list({ prefix })) out.push(e);
  return out;
}

test('text and json values round-trip; missing keys are null', { skip }, async t => {
  const { s } = await open(t);
  assert.equal(await s.get('nope'), null);
  await s.put('a', 'hello');
  await s.put('b', JSON.stringify({ n: 1 }));
  assert.equal(await s.get('a'), 'hello');
  assert.equal(await s.get('a', { type: 'text', cacheTtl: 30 }), 'hello');
  assert.deepEqual(await s.get('b', 'json'), { n: 1 });
  await s.put('a', 42);
  assert.equal(await s.get('a'), '42');
  await s.delete('a');
  assert.equal(await s.get('a'), null);
});

test('list filters by string prefix and returns metadata only where set', { skip }, async t => {
  const { s } = await open(t);
  await s.put('sub:b', '{}');
  await s.put('sub:a', '{}', { metadata: { email: 'a@x.test', status: 'active' } });
  await s.put('subscriber', '{}');
  await s.put('email-retry:1', '{}');
  const page = await s.list({ prefix: 'sub:' });
  assert.deepEqual(page, { keys: [{ name: 'sub:a', metadata: { email: 'a@x.test', status: 'active' } }, { name: 'sub:b' }], list_complete: true });
  assert.equal((await s.list()).keys.length, 4);
});

test('list pages with a cursor', { skip }, async t => {
  const { s } = await open(t);
  for (let i = 0; i < 5; i++) await s.put(`k:${i}`, String(i));
  const names = [];
  let cursor;
  let pages = 0;
  do {
    const page = await s.list({ prefix: 'k:', cursor, limit: 2 });
    names.push(...page.keys.map(k => k.name));
    cursor = page.list_complete ? undefined : page.cursor;
    pages++;
  } while (cursor);
  assert.deepEqual(names, ['k:0', 'k:1', 'k:2', 'k:3', 'k:4']);
  assert.equal(pages, 3);
});

test('expirationTtl is exact: gone from get and list the moment it passes', { skip }, async t => {
  const { s, clock } = await open(t);
  await s.put('alert:x', '1', { expirationTtl: 60 });
  clock.t += 59_000;
  assert.equal(await s.get('alert:x'), '1');
  clock.t += 1_000;
  assert.equal(await s.get('alert:x'), null);
  assert.deepEqual((await s.list({ prefix: 'alert:' })).keys, []);
});

test('an expired entry still has a version, and only that version unlocks it', { skip }, async t => {
  const { s, clock } = await open(t);
  await s.put('submission:1', 'old', { expirationTtl: 60 });
  clock.t += 61_000;
  const { value, version } = await s.getEntry('submission:1');
  assert.equal(value, null);
  assert.ok(version);
  assert.equal(await s.commit({ checks: [{ key: 'submission:1', version: null }], puts: [{ key: 'submission:1', value: 'new' }] }), false);
  assert.equal(await s.commit({ checks: [{ key: 'submission:1', version }], puts: [{ key: 'submission:1', value: 'new' }] }), true);
  assert.equal(await s.get('submission:1'), 'new');
});

test('values over 64 KiB are split into chunks and shrink back cleanly', { skip }, async t => {
  const { s, kv } = await open(t);
  const big = 'é'.repeat(100_000); // 200 000 UTF-8 bytes
  await s.put('nl-issue:2026-10-03', big, { metadata: { day: '2026-10-03' } });
  assert.equal(await s.get('nl-issue:2026-10-03'), big);
  const chunks = await raw(kv, ['c']);
  assert.equal(chunks.length, 4);
  assert.ok(chunks.every(c => c.value.length <= CHUNK));
  assert.deepEqual((await s.list({ prefix: 'nl-issue:' })).keys, [{ name: 'nl-issue:2026-10-03', metadata: { day: '2026-10-03' } }]);

  await s.put('nl-issue:2026-10-03', 'small');
  assert.equal(await s.get('nl-issue:2026-10-03'), 'small');
  assert.equal((await raw(kv, ['c'])).length, 0);

  await s.put('nl-issue:2026-10-03', big);
  await s.delete('nl-issue:2026-10-03');
  assert.equal(await s.get('nl-issue:2026-10-03'), null);
  assert.equal((await raw(kv, ['c'])).length, 0);
});

test('a missing chunk is an error, never partial text', { skip }, async t => {
  const { s, kv } = await open(t);
  await s.put('big', 'x'.repeat(3 * CHUNK));
  const [first] = await raw(kv, ['c']);
  await kv.delete(first.key);
  await assert.rejects(s.get('big'), /missing chunks/);
});

test('values and metadata past the limits are refused before anything is written', { skip }, async t => {
  const { s } = await open(t);
  await assert.rejects(s.put('huge', 'x'.repeat(12 * CHUNK + 1)), /over/);
  await assert.rejects(s.put('meta', '1', { metadata: { note: 'x'.repeat(1100) } }), /metadata/);
  assert.equal(await s.get('huge'), null);
  assert.equal(await s.get('meta'), null);
});

test('commit is compare-and-set on the version read', { skip }, async t => {
  const { s } = await open(t);
  const absent = await s.getEntry('config:sales');
  assert.deepEqual(absent, { value: null, version: null });
  assert.equal(await s.commit({ checks: [{ key: 'config:sales', version: null }], puts: [{ key: 'config:sales', value: '[1]' }, { key: 'other', value: 'x' }] }), true);
  assert.equal(await s.commit({ checks: [{ key: 'config:sales', version: null }], puts: [{ key: 'config:sales', value: '[2]' }, { key: 'other', value: 'y' }] }), false);
  assert.equal(await s.get('config:sales'), '[1]');
  assert.equal(await s.get('other'), 'x');
  const current = await s.getEntry('config:sales');
  assert.equal(current.value, '[1]');
  assert.equal(await s.commit({ checks: [{ key: 'config:sales', version: current.version }], deletes: ['other'], puts: [{ key: 'config:sales', value: '[3]' }] }), true);
  assert.equal(await s.get('config:sales'), '[3]');
  assert.equal(await s.get('other'), null);
  assert.equal(await s.commit({ checks: [{ key: 'config:sales', version: current.version }], puts: [{ key: 'config:sales', value: '[4]' }] }), false);
});
