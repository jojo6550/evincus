// Copies the live catalog (eras, products, stock, photos) to your local dev server: `npm run inventory:pull [url=<base>]`.
// One way only: the source is read, the local server is written. Orders, accounts, sessions and logs are never copied.
// Needs PROD_ADMIN_TOKEN (the live server's ADMIN_TOKEN) and your local ADMIN_TOKEN, in the environment or .env.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseOptions, adminToken, adminFetch, problem, PROD_URL, LOCAL_URL } from './lib/admin-cli.mjs';

const BATCH = 5;

export async function main(argv, { fetchFn = fetch, env = process.env, log = console.log, readEnvFile } = {}) {
  const { flags, rest } = parseOptions(argv);
  if (flags.local || rest.length) throw new Error('Usage: npm run inventory:pull [url=<base>]');
  const source = (flags.url ?? PROD_URL).replace(/\/+$/, '');
  const prodToken = adminToken(env, readEnvFile, 'PROD_ADMIN_TOKEN');
  const localToken = adminToken(env, readEnvFile);
  if (prodToken === localToken) throw new Error('PROD_ADMIN_TOKEN and ADMIN_TOKEN are the same, so your local server is using the production token. Give the local server its own ADMIN_TOKEN.');

  const exported = await adminFetch(source, prodToken, '/api/admin/export', { method: 'GET' }, fetchFn);
  if (!exported.ok) throw new Error(`Export from ${source}: ${await problem(exported)}`);
  const { eraOrder, eras, products, stock, media } = await exported.json();

  let copied = 0;
  for (let i = 0; i < media.length; i += BATCH) {
    await Promise.all(media.slice(i, i + BATCH).map(async name => {
      if ((await fetchFn(`${LOCAL_URL}/media/${name}`, { method: 'HEAD' })).ok) return;
      const file = await fetchFn(`${source}/media/${name}`);
      if (!file.ok) throw new Error(`Could not download ${name} from ${source} (${file.status}).`);
      const put = await adminFetch(LOCAL_URL, localToken, `/api/admin/media/${name}`, { method: 'PUT', body: new Uint8Array(await file.arrayBuffer()) }, fetchFn);
      if (!put.ok) throw new Error(`Upload of ${name}: ${await problem(put)}`);
      copied++;
    }));
  }

  const res = await adminFetch(LOCAL_URL, localToken, '/api/admin/import', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ eraOrder, eras, products, stock }) }, fetchFn);
  if (!res.ok) throw new Error(res.status === 404 ? 'The local server refused the import. Run it with npm run dev (ENVIRONMENT=development) and set ADMIN_TOKEN.' : `Import: ${await problem(res)}`);
  const done = await res.json();
  log(`Pulled from ${source}: ${done.eras} eras, ${done.products} products, ${done.stock} stock records (${done.removed} old local ones removed), ${copied} of ${media.length} photos copied.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(err => {
    console.error(err.message);
    process.exit(1);
  });
}
