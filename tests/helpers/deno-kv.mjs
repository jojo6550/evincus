// Real Deno KV, in memory, for Node tests (the @deno/kv npm package). Tests skip when its native build is missing
// on this machine; CI must run them, so there a missing build is an error.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let openKv;
try { ({ openKv } = await import('@deno/kv')); } catch { /* not installed for this platform */ }
if (!openKv && process.env.CI) throw new Error('@deno/kv failed to load in CI');

export const skip = openKv ? false : '@deno/kv native build not available';

export async function memoryKv(t) {
  const kv = await openKv();
  t.after(() => kv.close());
  return kv;
}

// A SQLite file, as in production. Only file KV enforces the per-commit limit of 10 checks; memory KV does not.
export async function fileKv(t) {
  const dir = await mkdtemp(join(tmpdir(), 'evincus-kv-'));
  const kv = await openKv(join(dir, 'kv.sqlite3'));
  t.after(async () => { kv.close(); await rm(dir, { recursive: true, force: true }); });
  return kv;
}
