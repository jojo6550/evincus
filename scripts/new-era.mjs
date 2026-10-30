// Creates a draft era on the store: `npm run new-era <slug> "<Name>" [local] [url=<base>]`.
// Fill it in and publish it in the inventory app. Needs ADMIN_TOKEN, like `npm run discount`.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseOptions, apiBase, adminToken, adminFetch, problem } from './lib/admin-cli.mjs';

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const USAGE = 'Usage: npm run new-era <slug> "<Name>" [local] [url=<base>]';

export async function newEra({ base, token, slug, name, fetchFn = fetch, log = console.log, where = base }) {
  if (!slug || !SLUG.test(slug)) throw new Error(`Slug must be lowercase kebab-case, e.g. summer-26 (got "${slug ?? ''}").`);
  if (!name || !name.trim()) throw new Error(`Name is required.\n${USAGE}`);
  const res = await adminFetch(base, token, '/api/admin/eras', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slug, name: name.trim() }),
  }, fetchFn);
  if (!res.ok) {
    let code;
    try { code = (await res.clone().json())?.error?.code; } catch { /* not JSON */ }
    if (code === 'era-exists') throw new Error(`An era "${slug}" already exists on ${where}.`);
    throw new Error(await problem(res));
  }
  log(`Created draft era ${slug} on ${where}. Fill it in and publish it at ${base}/inventory#inventory`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { flags, rest } = parseOptions(process.argv.slice(2));
    if (rest.length !== 2) throw new Error(USAGE);
    const base = apiBase(flags);
    await newEra({ base, token: adminToken(), slug: rest[0], name: rest[1], where: flags.local ? 'local' : flags.url ? base : 'PRODUCTION' });
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
