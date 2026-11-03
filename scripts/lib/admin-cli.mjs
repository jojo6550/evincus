// Shared by the admin scripts (discount, viewers): option parsing, token lookup, authenticated fetch.
import { readFileSync } from 'node:fs';

export const PROD_URL = 'https://www.evincus.shop'; // the bare domain redirects here, and fetch drops Authorization on that hop
export const LOCAL_URL = 'http://localhost:8000';

// Options also work as plain words (local, dry-run, label=..., url=...). npm never sees those,
// unlike --flags, which npm keeps for itself whenever the `--` is missing (Windows PowerShell drops it).
// words: { bare: flagName } booleans; values: names taken as name=value or --name value. local and url always work.
export function parseOptions(argv, { words = {}, values = [] } = {}) {
  const w = { local: 'local', ...words };
  const v = ['url', ...values];
  const flags = { url: null };
  for (const k of Object.values(w)) flags[k] = false;
  for (const k of values) flags[k] = null;
  const kvRe = new RegExp(`^(?:--)?(${v.join('|')})=([\\s\\S]*)$`);
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const word = w[a.replace(/^--/, '')];
    const kv = kvRe.exec(a);
    if (word) flags[word] = true;
    else if (kv) flags[kv[1]] = kv[2];
    else if (a.startsWith('--') && v.includes(a.slice(2))) {
      const val = argv[++i];
      if (val === undefined) throw new Error(`${a} needs a value.`);
      flags[a.slice(2)] = val;
    } else if (a.startsWith('--')) throw new Error(`Unknown option ${a}.`);
    else rest.push(a);
  }
  if (flags.url && flags.local) throw new Error('Use url= or local, not both.');
  return { flags, rest };
}

export const apiBase = flags => (flags.local ? LOCAL_URL : flags.url ?? PROD_URL).replace(/\/+$/, '');

// The token from the environment, else from .env in the repo root.
export function adminToken(env = process.env, readEnvFile = () => readFileSync(new URL('../../.env', import.meta.url), 'utf8'), name = 'ADMIN_TOKEN') {
  if (env[name]) return env[name];
  let text = '';
  try { text = readEnvFile(); } catch { /* no .env */ }
  const token = new RegExp(`^[ \\t]*${name}[ \\t]*=[ \\t]*(["']?)([^"'\\r\\n]*?)\\1[ \\t]*$`, 'm').exec(text)?.[2];
  if (token) return token;
  throw new Error(`Set ${name} (the same value as on the server) in your environment or in .env.`);
}

export async function adminFetch(base, token, path, init = {}, fetchFn = fetch) {
  try {
    return await fetchFn(`${base}${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, ...init.headers } });
  } catch (err) {
    throw new Error(`Could not reach ${base} (${err.message}). ${base === LOCAL_URL ? 'Start it with npm run dev.' : 'Check the URL and your connection.'}`);
  }
}

export async function problem(res) {
  if (res.status === 401) return 'The API refused the admin token. Check ADMIN_TOKEN matches the server.';
  if (res.status === 404) return 'The API has no admin endpoint. Set ADMIN_TOKEN on the server (Render environment variables, or .env for npm run dev).';
  let message = '';
  try { message = (await res.json())?.error?.message ?? ''; } catch { /* not JSON */ }
  return `The API answered ${res.status}${message ? `: ${message}` : ''}.`;
}
