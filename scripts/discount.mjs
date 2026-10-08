// Runs a timed sale on the live store: `npm run discount -- <eras|all> <days> <percent>`.
// Sales are stored in the API's ORDERS KV namespace (key config:sales) and take effect within about a minute,
// with no deploy. See `npm run discount -- help`.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SALE_MAX_PERCENT, isSale, pendingSales } from '../data/catalog.js';

export const SALES_KEY = 'config:sales';
const DAY = 86_400_000;
const MAX_DAYS = 365;

export const USAGE = `Usage:
  npm run discount -- <eras> <days> <percent> [options]   start a sale
  npm run discount -- list [options]                      show running and scheduled sales
  npm run discount -- end <id|all> [options]              end a sale now

  <eras>     all, one era slug, or several joined by commas: catastrophe,core
  <days>     how long it runs, e.g. 3 or 0.5 (12 hours)
  <percent>  1 to ${SALE_MAX_PERCENT}, e.g. 20 or 20%

Options:
  --label "Text"   headline on the sale banner (default: the era names)
  --starts <ISO>   schedule the start, e.g. 2026-11-27T09:00:00-05:00 (default: now)
  --staging        use the staging API instead of production
  --local          use the local wrangler dev store (npm run dev:api)
  --dry-run        print the change without saving it

Examples:
  npm run discount -- catastrophe 3 20
  npm run discount -- catastrophe,core 7 15% --label "Fall sale"
  npm run discount -- all 2 30 --starts 2026-11-27T00:00:00-05:00
  npm run discount -- end all`;

export function parseArgs(argv) {
  const flags = { staging: false, local: false, dryRun: false, label: null, starts: null };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--staging') flags.staging = true;
    else if (a === '--local') flags.local = true;
    else if (a === '--dry-run') flags.dryRun = true;
    else if (a === '--label' || a === '--starts') {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value.`);
      flags[a.slice(2)] = v;
    } else if (a.startsWith('--')) throw new Error(`Unknown option ${a}.`);
    else rest.push(a);
  }
  if (flags.staging && flags.local) throw new Error('Use --staging or --local, not both.');
  const [cmd, ...args] = rest;
  if (!cmd || cmd === 'help') return { cmd: 'help', flags };
  if (cmd === 'list') return { cmd: 'list', flags };
  if (cmd === 'end') {
    if (args.length !== 1) throw new Error('Say which sale to end: npm run discount -- end <id|all>');
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
  if (!pending.some(s => s.id === id)) throw new Error(`No running or scheduled sale with id ${id}. See npm run discount -- list.`);
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

// ---------- KV through wrangler ----------

const ROOT = new URL('../', import.meta.url);
const CONFIG = fileURLToPath(new URL('worker/wrangler.toml', ROOT));
const WRANGLER = fileURLToPath(new URL('node_modules/wrangler/bin/wrangler.js', ROOT));

function target(flags) {
  if (flags.local) return ['--local'];
  const toml = readFileSync(CONFIG, 'utf8');
  const prod = toml.split(/^\[env\./m)[0];
  const placeholder = flags.staging ? /REPLACE_WITH_ORDERS_STAGING_KV_ID/.test(toml) : /id = "local-orders"/.test(prod);
  if (placeholder) throw new Error(`worker/wrangler.toml has no real ORDERS KV id for ${flags.staging ? 'staging' : 'production'} yet. Set it first (README, First deploy checklist), or use --local.`);
  return ['--remote', ...(flags.staging ? ['--env', 'staging'] : [])];
}

function wrangler(args) {
  return execFileSync(process.execPath, [WRANGLER, ...args, '--binding', 'ORDERS', '--config', CONFIG], {
    cwd: fileURLToPath(ROOT), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
}

// Wrangler may print a banner around the value, so the JSON array is cut out of the output.
export function parseStored(out) {
  const text = String(out).trim();
  if (!text || /value not found/i.test(text)) return [];
  const json = text.startsWith('[') ? text : text.slice(text.indexOf('['), text.lastIndexOf(']') + 1);
  const list = JSON.parse(json);
  if (!Array.isArray(list)) throw new Error(`${SALES_KEY} in KV is not a list.`);
  return list;
}

function read(flags) {
  try {
    return parseStored(wrangler(['kv', 'key', 'get', SALES_KEY, '--text', ...target(flags)]));
  } catch (err) {
    if (/value not found/i.test(`${err.stdout ?? ''}${err.stderr ?? ''}`)) return [];
    throw err;
  }
}

function write(flags, list) {
  const dir = mkdtempSync(join(tmpdir(), 'evincus-sales-'));
  try {
    const file = join(dir, 'sales.json');
    writeFileSync(file, JSON.stringify(list));
    wrangler(['kv', 'key', 'put', SALES_KEY, '--path', file, ...target(flags)]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main(argv) {
  const opts = parseArgs(argv);
  if (opts.cmd === 'help') return console.log(USAGE);
  const { flags } = opts;
  const where = flags.local ? 'local' : flags.staging ? 'staging' : 'PRODUCTION';
  const now = new Date();
  const list = read(flags);

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
  write(flags, next);
  console.log(`${done}\nShoppers see the change within about a minute.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(err => {
    console.error(err.stderr ? `${err.message}\n${err.stderr}` : err.message);
    process.exit(1);
  });
}
