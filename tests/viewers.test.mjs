import test from 'node:test';
import assert from 'node:assert/strict';
import { generatePassword, main } from '../scripts/viewers.mjs';
import { hashPassword, ITERATIONS } from '../server/lib/accounts.js';

const env = { ADMIN_TOKEN: 'tok' };
const json = (status, body) => new Response(body === undefined ? null : JSON.stringify(body), { status });

// Records calls; replies with the queued responses.
function stub(...replies) {
  const calls = [];
  const fetchFn = async (url, init) => { calls.push({ url, init }); return replies.shift(); };
  return { calls, fetchFn };
}
const run = async (argv, replies) => {
  const s = stub(...replies);
  const out = [];
  await main(argv, { fetchFn: s.fetchFn, env, log: line => out.push(line) });
  return { ...s, out: out.join('\n') };
};

test('generatePassword is 20 characters from the 58-letter alphabet', () => {
  const seen = new Set();
  for (let i = 0; i < 1000; i++) {
    const p = generatePassword();
    assert.match(p, /^[1-9A-HJ-NP-Za-km-z]{20}$/);
    seen.add(p);
  }
  assert.equal(seen.size, 1000);
});

test('add sends only salt and hash, never the password, and owner sets the role', async () => {
  const s = stub(json(200, { email: 'a@b.co', role: 'owner', created: true }));
  const out = [];
  await main(['add', 'a@b.co', 'owner', 'local'], { fetchFn: s.fetchFn, env, log: l => out.push(l) });
  const [{ url, init }] = s.calls;
  assert.equal(url, 'http://localhost:8000/api/admin/accounts');
  assert.equal(init.method, 'PUT');
  assert.equal(init.headers.Authorization, 'Bearer tok');
  const body = JSON.parse(init.body);
  assert.deepEqual(Object.keys(body).sort(), ['email', 'hash', 'iterations', 'role', 'salt']);
  assert.equal(body.role, 'owner');
  assert.equal(body.iterations, ITERATIONS);
  assert.equal(Buffer.from(body.salt, 'base64').length, 16);
  const printed = out.join('\n');
  const password = /: (\S{20})$/m.exec(printed)[1];
  assert.equal(body.hash, await hashPassword(password, body.salt, ITERATIONS));
  assert.ok(!init.body.includes(password));
  assert.match(printed, /Password for a@b\.co \(owner\) on local: /);
  assert.match(printed, /Shown once\. Send it privately\./);
});

test('add without a role on an existing account sends no role', async () => {
  const { calls, out } = await run(['add', 'a@b.co', 'local'], [json(200, { email: 'a@b.co', role: 'owner', created: false })]);
  assert.ok(!('role' in JSON.parse(calls[0].init.body)));
  assert.match(out, /\(owner\)/);
});

test('add on 409 prints the server message, exits non-zero and shows no password', async () => {
  const s = stub(json(409, { error: { code: 'account-changed', message: 'Account changed, try again.' } }));
  const out = [];
  await assert.rejects(main(['add', 'a@b.co', 'local'], { fetchFn: s.fetchFn, env, log: l => out.push(l) }), /Account changed, try again\./);
  assert.equal(s.calls.length, 1);
  assert.equal(out.length, 0);
});

test('remove and list hit the account endpoints with the token', async () => {
  let r = await run(['remove', 'a+b@c.co', 'url=https://x.test/'], [json(204)]);
  assert.equal(r.calls[0].url, 'https://x.test/api/admin/accounts/a%2Bb%40c.co');
  assert.equal(r.calls[0].init.method, 'DELETE');
  assert.equal(r.calls[0].init.headers.Authorization, 'Bearer tok');

  r = await run(['list', 'local'], [json(200, { accounts: [{ email: 'a@b.co', role: 'viewer', createdAt: 't1', lastLoginAt: null }] })]);
  assert.equal(r.calls[0].url, 'http://localhost:8000/api/admin/accounts');
  assert.match(r.out, /a@b\.co/);
  assert.match(r.out, /viewer/);
});

test('remove of an unknown account fails with a clear message', async () => {
  await assert.rejects(run(['remove', 'x@y.co', 'local'], [json(404, { error: { code: 'not-found', message: 'No such account.' } })]), /No such account/);
});
