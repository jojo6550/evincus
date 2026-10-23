// Validate a checkpointed SQLite snapshot in disposable storage. Never starts
// the application, its scheduler, or an email client; never prints record values.
import { mkdtemp, copyFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { openKv } from '@deno/kv';
import { kvStore } from '../server/lib/kv-store.js';

const snapshot = process.argv[2];
if (!snapshot || (snapshot !== '--fixture' && snapshot.startsWith('--'))) throw new Error('Usage: node scripts/restore-check.mjs <checkpointed-snapshot.sqlite3|--fixture>');
const dir = await mkdtemp(join(tmpdir(), 'evincus-restore-'));
let kv;
try {
  let source = resolve(snapshot);
  if (snapshot === '--fixture') {
    source = join(dir, 'fixture.sqlite3');
    kv = await openKv(source);
    const store = kvStore(kv);
    for (const [key, value] of Object.entries({ 'order:fixture': '{"status":"PLACED","paymentStatus":"NOT_COLLECTED"}', 'submission:fixture': '{"fingerprint":"fixture"}', 'day:2026-10-18:fixture': '', 'email-retry:fixture': '{"retries":0}', 'sub:fixture': '{"status":"active"}', 'config:sales': '[]', 'digest-last-prepared': '2026-10-17', 'nl-last': '2026-10-17T13:00:00Z', 'large:fixture': 'x'.repeat(180000) })) await store.put(key, value);
    kv.close(); kv = null;
  }
  const wal = await stat(source + '-wal').catch(() => null);
  if (wal?.size) throw new Error('Use a checkpointed snapshot from a stopped database, not a live SQLite file with a WAL');
  const restored = join(dir, 'restored.sqlite3');
  await copyFile(source, restored);
  const inspect = async file => {
    kv = await openKv(file);
    const store = kvStore(kv);
    const counts = {}, hash = createHash('sha256');
    let cursor;
    do {
      const page = await store.list({ cursor, limit: 100 });
      for (const { name } of page.keys) {
        const prefix = name.split(':')[0]; counts[prefix] = (counts[prefix] ?? 0) + 1;
        const value = await store.get(name);
        if (value === null) throw new Error('Snapshot contains an unreadable record');
        hash.update(JSON.stringify([name, value]));
      }
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
    kv.close(); kv = null;
    return { counts, digest: hash.digest('hex') };
  };
  // Inspect disposable copies only; the supplied snapshot is never opened for writes.
  const secondCopy = join(dir, 'comparison.sqlite3');
  await copyFile(source, secondCopy);
  const expected = await inspect(secondCopy);
  const actual = await inspect(restored);
  if (actual.digest !== expected.digest) throw new Error('Restored records do not match the snapshot');
  console.log(JSON.stringify({ testedAt: new Date().toISOString(), snapshot: snapshot === '--fixture' ? 'synthetic fixture' : 'provided checkpointed snapshot', email: 'no email or scheduler code loaded', counts: actual.counts, integrity: 'all logical values readable and match snapshot', productionRestoreVerified: false }, null, 2));
} finally { kv?.close(); await rm(dir, { recursive: true, force: true }); }
