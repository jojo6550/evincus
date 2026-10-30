// Selected log lines, kept 30 days in KV for the Logs tab. Best-effort: a failing store never touches the request.
import { HttpError } from './http.js';
import { listAll } from './stock.js';
import { REV_KEY } from './catalog-store.js';

const TTL = 2592000;
const PAGE = 100;
const DAY = 86400000;

// level and event ride in the key's metadata, so filtering needs no value reads.
export const logSink = (env, waitUntil) => line => {
  const key = `log:${line.ts}:${crypto.randomUUID().slice(0, 8)}`;
  waitUntil(Promise.resolve().then(() => env.ORDERS.put(key, JSON.stringify(line), { expirationTtl: TTL, metadata: { l: line.level, e: String(line.event).slice(0, 64) } })).catch(() => {}));
};

// Newest first. KV lists ascending only, so walk the days backwards from `before` (a key from the last page) and list
// each day on its own. shortcut: one day's keys are listed whole, upgrade if a day ever holds tens of thousands.
export async function readLogs(env, { level, kind, before, now }) {
  if (level && !['error', 'warn', 'info'].includes(level)) throw new HttpError('invalid-query', 400);
  if (kind && !/^[a-z_]{1,32}$/.test(kind)) throw new HttpError('invalid-query', 400);
  if (before && !/^log:\d{4}-\d{2}-\d{2}T\S{1,64}$/.test(before)) throw new HttpError('invalid-query', 400);
  const start = before ? Date.parse(before.slice(4, 14)) : Math.floor(now.getTime() / DAY) * DAY;
  const picked = [];
  for (let d = 0; d <= 31 && picked.length <= PAGE; d++) {
    const day = new Date(start - d * DAY).toISOString().slice(0, 10);
    const keys = (await listAll(env.ORDERS, `log:${day}`)).filter(k => (!before || k.name < before)
      && (!level || k.metadata?.l === level) && (!kind || String(k.metadata?.e).split('.')[0] === kind));
    picked.push(...keys.reverse());
  }
  const page = picked.slice(0, PAGE);
  const logs = (await Promise.all(page.map(async k => {
    try { return await env.ORDERS.get(k.name, 'json'); } catch { return null; }
  }))).filter(Boolean);
  return { logs, next: picked.length > PAGE ? page.at(-1).name : null };
}

const cache = new WeakMap(); // env → { at, bytes }

async function mediaBytes(env, nowMs) {
  const hit = cache.get(env);
  if (hit && nowMs - hit.at < 60000) return hit.bytes;
  const bytes = (await env.MEDIA.list()).reduce((n, f) => n + f.size, 0);
  cache.set(env, { at: nowMs, bytes });
  return bytes;
}

// Each piece reads on its own; one that fails shows "unknown" instead of failing the response.
export async function healthExtras(env, now) {
  const piece = async fn => { try { return (await fn()) ?? 'unknown'; } catch { return 'unknown'; } };
  const [diskFreeBytes, media, lastCronAt, emailRetryCount, lastDigestDay, rev] = await Promise.all([
    piece(() => env.DISK_FREE?.()),
    piece(() => mediaBytes(env, now.getTime())),
    piece(() => env.ORDERS.get('cron:lastRun')),
    piece(async () => (await listAll(env.ORDERS, 'email-retry:')).length),
    piece(async () => (await listAll(env.ORDERS, 'digest-sent:')).at(-1)?.name.slice('digest-sent:'.length) ?? 'none'),
    piece(async () => (await env.ORDERS.get(REV_KEY, 'json'))?.rev),
  ]);
  return { diskFreeBytes, mediaBytes: media, lastCronAt, emailRetryCount, lastDigestDay, rev };
}
