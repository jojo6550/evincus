import test from 'node:test';
import assert from 'node:assert/strict';
import { skip, memoryKv } from './helpers/deno-kv.mjs';
import { kvLimiter } from '../server/lib/limiter.js';

const hits = async (limiter, key, n) => {
  const out = [];
  for (let i = 0; i < n; i++) out.push((await limiter.limit({ key })).success);
  return out;
};

test('allows up to the limit per key and per name, then refuses', { skip }, async t => {
  const kv = await memoryKv(t);
  const order = kvLimiter(kv, 'order', { limit: 2, period: 60, now: () => 0 });
  const beacon = kvLimiter(kv, 'beacon', { limit: 2, period: 60, now: () => 0 });
  assert.deepEqual(await hits(order, '1.1.1.1', 3), [true, true, false]);
  assert.deepEqual(await hits(order, '2.2.2.2', 1), [true]);
  assert.deepEqual(await hits(beacon, '1.1.1.1', 1), [true]);
});

test('a new window starts fresh', { skip }, async t => {
  const kv = await memoryKv(t);
  const clock = { t: 0 };
  const l = kvLimiter(kv, 'order', { limit: 1, period: 60, now: () => clock.t });
  assert.deepEqual(await hits(l, 'ip', 2), [true, false]);
  clock.t = 59_999;
  assert.deepEqual(await hits(l, 'ip', 1), [false]);
  clock.t = 60_000;
  assert.deepEqual(await hits(l, 'ip', 1), [true]);
});

test('concurrent hits never pass the limit and refused hits write nothing', { skip }, async t => {
  const kv = await memoryKv(t);
  const l = kvLimiter(kv, 'order', { limit: 5, period: 60, now: () => 0 });
  const results = await Promise.all(Array.from({ length: 8 }, () => l.limit({ key: 'ip' })));
  assert.equal(results.filter(r => r.success).length, 5);
  assert.equal((await kv.get(['rl', 'order', 'ip', 0])).value, 5);
});

test('a limit of 10 holds under 30 concurrent hits', { skip }, async t => {
  const kv = await memoryKv(t);
  const l = kvLimiter(kv, 'beacon', { limit: 10, period: 60, now: () => 0 });
  const results = await Promise.all(Array.from({ length: 30 }, () => l.limit({ key: 'ip' })));
  assert.equal(results.filter(r => r.success).length, 10);
  assert.equal((await kv.get(['rl', 'beacon', 'ip', 0])).value, 10);
});
