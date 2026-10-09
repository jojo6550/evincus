// Runs a timed sale on the live store: `npm run discount <eras|all> <days> <percent>`.
// Sales are stored in KV (key config:sales) through the server's /api/admin/sales endpoint and apply on the next
// page load, with no deploy. See `npm run discount help`.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SALE_MAX_PERCENT, isSale, pendingSales } from '../data/catalog.js';

export const PROD_URL = 'https://evincus.jojo6550.deno.net';
export const LOCAL_URL = 'http://localhost:8000';

export const SALES_KEY = 'config:sales';
const DAY = 86_400_000;
const MAX_DAYS = 365;

export const USAGE = `Usage:
  npm run discount <eras> <days> <percent> [options]   start a sale
  npm run discount list [options]                      show running and scheduled sales
  npm run discount end <id|all> [options]              end a sale now

  <eras>     all, one era slug, or several joined by commas: catastrophe,core
  <days>     how long it runs, e.g. 3 or 0.5 (12 hours)
  <percent>  1 to ${SALE_MAX_PERCENT}, e.g. 20 or 20%

Options (plain words, so npm and PowerShell pass them through):
  label="Text"     headline on the sale banner (default: the era names)
  starts=<ISO>     schedule the start, e.g. starts=2026-11-27T09:00:00-05:00 (default: now)
  local            use the local server (npm run dev)
  url=<base>       use another deployment, e.g. a branch preview URL
  dry-run          print the change without saving it
Needs ADMIN_TOKEN (the server's value) in your environment or in .env.

Examples:
  npm run discount catastrophe 3 20 local
  npm run discount catastrophe,core 7 15% label="Fall sale"
  npm run discount all 2 30 starts=2026-11-27T00:00:00-05:00
  npm run discount list local
  npm run discount end all`;

// Options also work as plain words (local, dry-run, label=..., starts=..., url=...). npm never sees those,
// unlike --flags, which npm keeps for itself whenever the `--` is missing (Windows PowerShell drops it).
const WORDS = { local: 'local', 'dry-run': 'dryRun' };

export function parseArgs(argv) {
  const flags = { local: false, dryRun: false, label: null, starts: null, url: null };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const bare = a.replace(/^--/, '');
    if (bare === 'staging') throw new Error('staging is gone: each branch has its own preview. Use url=<preview URL> instead.');
    const word = WORDS[bare];
    const kv = /^(?:--)?(label|starts|url)=([\s\S]*)$/.exec(a);
    if (word) flags[word] = true;
    else if (kv) flags[kv[1]] = kv[2];
    else if (a === '--label' || a === '--starts' || a === '--url') {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value.`);
      flags[a.slice(2)] = v;
    } else if (a.startsWith('--')) throw new Error(`Unknown option ${a}.`);
    else rest.push(a);
  }
  if (flags.url && flags.local) throw new Error('Use url= or local, not both.');
  const [cmd, ...args] = rest;
  if (!cmd || cmd === 'help') return { cmd: 'help', flags };
  if (cmd === 'list') return { cmd: 'list', flags };
  if (cmd === 'end') {
    if (args.length !== 1) throw new Error('Say which sale to end: npm run discount end <id|all>');
    return { cmd: 'end', id: args[0], flags };
  }
  if (args.length !== 2) throw new Error(`Expected <eras> <days> <percent>.\n\n${USAGE}`);
  return { cmd: 'start', target: cmd, days: args[0], percent: args[1], flags };
}

// Builds a validated sale. `known` is the list of era slugs in data/eras.
export function makeSale({ target, days, percent, label = null, starts = null }, known, now, id = randomId()) {
  const eras = String(target).toLowerCase() === 'all' ? null : [...new Set(String(target).split(',').map(s => s.trim()).filter(Boolean))];
  if (eras && !eras.length) throw new Error('Name at least one era, or use all.');
  const unknown = (eras ?? []).filter(s => !known.includes(s));
  if (unknown.length) throw new Error(`Unknown era ${unknown.join(', ')}. Eras: ${known.join(', ')}.`);

  const d = Number(String(days).replace(/d$/i, ''));
  if (!Number.isFinite(d) || d <= 0 || d > MAX_DAYS) throw new Error(`Days must be a number above 0 and at most ${MAX_DAYS} (got "${days}").`);
  const pct = Number(String(percent).replace(/%$/, ''));
  if (!Number.isInteger(pct) || pct < 1 || pct > SALE_MAX_PERCENT) throw new Error(`Percent must be a whole number from 1 to ${SALE_MAX_PERCENT} (got "${percent}").`);

  const start = starts === null ? +now : Date.parse(starts);
  if (!Number.isFinite(start)) throw new Error(`--starts must be an ISO date with an offset, e.g. 2026-11-27T09:00:00-05:00 (got "${starts}").`);
  if (start < +now - 60_000) throw new Error('--starts is in the past.');
  if (label !== null && (!label.trim() || label.length > 40)) throw new Error('--label must be 1 to 40 characters.');

  const sale = {
    id, percent: pct, eras, label: label?.trim() ?? null,
    startsAt: new Date(start).toISOString(), endsAt: new Date(start + Math.round(d * DAY)).toISOString(),
  };
  if (!isSale(sale)) throw new Error('That sale is not valid.');
  return sale;
}

function randomId() {
  return crypto.randomUUID().slice(0, 6);
}

// Drops ended sales, then adds `sale`.
export const addSale = (list, sale, now) => [...pendingSales(list, now), sale];

export function endSale(list, id, now) {
  const pending = pendingSales(list, now);
  if (id === 'all') return [];
  if (!pending.some(s => s.id === id)) throw new Error(`No running or scheduled sale with id ${id}. See npm run discount list.`);
  return pending.filter(s => s.id !== id);
}

const left = ms => {
  const d = Math.floor(ms / DAY), h = Math.floor(ms % DAY / 3_600_000), m = Math.floor(ms % 3_600_000 / 60_000);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
};

export function describe(s, now) {
  const scope = s.eras ? s.eras.join(', ') : 'all eras';
  const started = Date.parse(s.startsAt) <= +now;
  const when = started ? `ends in ${left(Date.parse(s.endsAt) - now)} (${s.endsAt})` : `starts ${s.startsAt}, runs until ${s.endsAt}`;
  return `  ${s.id}  ${String(s.percent).padStart(2)}% off  ${scope}${s.label ? `  "${s.label}"` : ''}\n          ${started ? 'LIVE' : 'SCHEDULED'}, ${when}`;
}

// ---------- the admin endpoint ----------

export const apiBase = flags => (flags.local ? LOCAL_URL : flags.url ?? PROD_URL).replace(/\/+$/, '');

// ADMIN_TOKEN from the environment, else from .env in the repo root.
export function adminToken(env = process.env, readEnvFile = () => readFileSync(new URL('../.env', import.meta.url), 'utf8')) {
  if (env.ADMIN_TOKEN) return env.ADMIN_TOKEN;
  let text = '';
  try { text = readEnvFile(); } catch { /* no .env */ }
  const token = /^[ \t]*ADMIN_TOKEN[ \t]*=[ \t]*(["']?)([^"'\r\n]*?)\1[ \t]*$/m.exec(text)?.[2];
  if (token) return token;
  throw new Error('Set ADMIN_TOKEN (the same value as on the server) in your environment or in .env.');
}

async function request(base, token, init, fetchFn) {
  try {
    return await fetchFn(`${base}/api/admin/sales`, { ...init, headers: { Authorization: `Bearer ${token}`, ...init.headers } });
  } catch (err) {
    throw new Error(`Could not reach ${base} (${err.message}). ${base === LOCAL_URL ? 'Start it with npm run dev.' : 'Check the URL and your connection.'}`);
  }
}

async function problem(res) {
  if (res.status === 401) return 'The API refused the admin token. Check ADMIN_TOKEN matches the server.';
  if (res.status === 404) return 'The API has no admin endpoint. Set ADMIN_TOKEN on the server (Deno Deploy environment variables, or .env for npm run dev).';
  let message = '';
  try { message = (await res.json())?.error?.message ?? ''; } catch { /* not JSON */ }
  return `The API answered ${res.status}${message ? `: ${message}` : ''}.`;
}

export async function readSales(base, token, fetchFn = fetch) {
  const res = await request(base, token, { method: 'GET' }, fetchFn);
  if (!res.ok) throw new Error(await problem(res));
  const { sales, version } = await res.json();
  if (!Array.isArray(sales)) throw new Error('The API returned sales that are not a list.');
  return { sales, version };
}

export async function writeSales(base, token, sales, version, fetchFn = fetch) {
  const res = await request(base, token, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sales, version }) }, fetchFn);
  if (res.status === 409) throw new Error('Sales changed since this command read them. Run npm run discount list, then try again.');
  if (!res.ok) throw new Error(await problem(res));
}

async function main(argv) {
  const opts = parseArgs(argv);
  if (opts.cmd === 'help') return console.log(USAGE);
  const { flags } = opts;
  const base = apiBase(flags);
  const where = flags.local ? 'local' : flags.url ? base : 'PRODUCTION';
  const token = adminToken();
  const now = new Date();
  const { sales: list, version } = await readSales(base, token);

  if (opts.cmd === 'list') {
    const pending = pendingSales(list, now);
    return console.log(pending.length ? `Sales on ${where}:\n${pending.map(s => describe(s, now)).join('\n')}` : `No running or scheduled sales on ${where}.`);
  }

  let next, done;
  if (opts.cmd === 'end') {
    next = endSale(list, opts.id, now);
    done = opts.id === 'all' ? `Ended every sale on ${where}.` : `Ended sale ${opts.id} on ${where}.`;
  } else {
    const { FOLDERS } = await import('../data/eras/index.js');
    const sale = makeSale({ ...opts, label: flags.label, starts: flags.starts }, FOLDERS, now);
    next = addSale(list, sale, now);
    done = `Sale saved on ${where}:\n${describe(sale, now)}`;
  }

  if (flags.dryRun) return console.log(`Dry run, nothing saved. ${where} would have:\n${JSON.stringify(next, null, 2)}`);
  await writeSales(base, token, next, version);
  console.log(`${done}\nShoppers see the change on their next page load.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(err => {
    console.error(err.message);
    process.exit(1);
  });
}
