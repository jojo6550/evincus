// Manages /inventory logins on the live store: `npm run add-viewer <email> [viewer|owner] [local|url=<base>]`,
// `npm run remove-viewer <email>`, `npm run list-viewers`. Needs ADMIN_TOKEN, like `npm run discount`.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashPassword, ITERATIONS } from '../server/lib/accounts.js';
import { parseOptions, apiBase, adminToken, adminFetch, problem } from './lib/admin-cli.mjs';

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const LIMIT = 256 - (256 % ALPHABET.length); // bytes at or above this would skew the pick

// Rejection sampling keeps every letter equally likely.
export function generatePassword(random = a => crypto.getRandomValues(a)) {
  let out = '';
  while (out.length < 20) {
    for (const b of random(new Uint8Array(32))) if (b < LIMIT && out.length < 20) out += ALPHABET[b % ALPHABET.length];
  }
  return out;
}

export const USAGE = `Usage:
  npm run add-viewer <email> [viewer|owner] [options]   create a login, or reset its password
  npm run remove-viewer <email> [options]               delete a login (its sessions stop working)
  npm run list-viewers [options]                        show logins

Options: local, url=<base>. Needs ADMIN_TOKEN in your environment or in .env.`;

// Errors carry the server's message, never the password.
async function fail(res) {
  let body = null;
  try { body = await res.clone().json(); } catch { /* not JSON */ }
  const code = body?.error?.code;
  if (body?.error?.message && (code === 'account-changed' || code === 'not-found' || code === 'invalid-account')) throw new Error(body.error.message);
  throw new Error(await problem(res));
}

export async function main(argv, { fetchFn = fetch, env = process.env, log = console.log } = {}) {
  const [cmd, ...more] = argv;
  const { flags, rest } = parseOptions(more);
  const base = apiBase(flags);
  const where = flags.local ? 'local' : flags.url ? base : 'PRODUCTION';
  const call = (path, init) => adminFetch(base, adminToken(env), `/api/admin/accounts${path}`, init, fetchFn);

  if (cmd === 'list') {
    const res = await call('', { method: 'GET' });
    if (!res.ok) await fail(res);
    const { accounts } = await res.json();
    if (!accounts.length) return log(`No logins on ${where}.`);
    return log(`Logins on ${where}:\n${accounts.map(a => `  ${a.email}  ${a.role}  created ${a.createdAt}  last login ${a.lastLoginAt ?? 'never'}`).join('\n')}`);
  }

  const [email, ...extra] = rest;
  if (!email) throw new Error(USAGE);

  if (cmd === 'remove') {
    if (extra.length) throw new Error(USAGE);
    const res = await call(`/${encodeURIComponent(email)}`, { method: 'DELETE' });
    if (!res.ok) await fail(res);
    return log(`Removed ${email} on ${where}.`);
  }

  if (cmd === 'add') {
    const role = extra[0];
    if (extra.length > 1 || (role && role !== 'viewer' && role !== 'owner')) throw new Error(USAGE);
    const password = generatePassword();
    const salt = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64');
    const hash = await hashPassword(password, salt, ITERATIONS);
    // No role word: the server makes new accounts viewers and leaves existing roles alone.
    const body = { email, ...(role && { role }), salt, hash, iterations: ITERATIONS };
    const res = await call('', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) await fail(res);
    const saved = await res.json();
    // Printed only after the server confirms, so a failed call never shows a password that does not work.
    log(`Password for ${saved.email} (${saved.role}) on ${where}: ${password}`);
    return log('Shown once. Send it privately.');
  }

  throw new Error(USAGE);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(err => {
    console.error(err.message);
    process.exit(1);
  });
}
