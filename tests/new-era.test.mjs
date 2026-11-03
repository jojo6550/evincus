import test from 'node:test';
import assert from 'node:assert/strict';
import { newEra } from '../scripts/new-era.mjs';

const json = (status, body) => new Response(JSON.stringify(body), { status });

test('new-era posts slug and name and reports a draft', async () => {
  const calls = [];
  const fetchFn = async (url, init) => { calls.push({ url, init }); return json(201, { era: {}, version: 'v' }); };
  const out = [];
  await newEra({ base: 'http://localhost:8000', token: 'tok', slug: 'summer-26', name: ' Summer 26 ', fetchFn, log: l => out.push(l), where: 'local' });
  assert.equal(calls[0].url, 'http://localhost:8000/api/admin/eras');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer tok');
  assert.deepEqual(JSON.parse(calls[0].init.body), { slug: 'summer-26', name: 'Summer 26' });
  assert.equal(out[0], 'Created draft era summer-26 on local. Fill it in and publish it at http://localhost:8000/inventory#inventory');
});

test('new-era refuses a bad slug before calling the server', async () => {
  let called = false;
  const fetchFn = async () => { called = true; };
  for (const slug of ['', undefined, 'Summer', 'a_b', '-x', 'x-', '../x']) await assert.rejects(newEra({ base: 'http://x', token: 't', slug, name: 'X', fetchFn }), /kebab-case/);
  await assert.rejects(newEra({ base: 'http://x', token: 't', slug: 'x', name: '  ', fetchFn }), /Name is required/);
  assert.equal(called, false);
});

test('new-era says so when the era exists', async () => {
  const fetchFn = async () => json(409, { error: { code: 'era-exists', message: 'm' } });
  await assert.rejects(newEra({ base: 'http://x', token: 't', slug: 'core', name: 'Core', fetchFn }), /"core" already exists/);
});
