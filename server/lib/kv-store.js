// A get/put/delete/list store over Deno KV, so the libs keep calling it with plain string keys.
//
// Each key has a head entry ['s', key] → { v, m, x, n, id }:
//   v   the value as UTF-8 bytes, or null when it is split into chunks
//   m   metadata (returned by list), or null
//   x   expiry in epoch ms, or null. Expired entries read as missing, so TTLs are exact, not best-effort;
//       Deno's own expireIn is set too, only to clean them up.
//   n   chunk count, id  the chunk set's id
// Deno KV caps a value at 64 KiB, so bigger values go to ['c', key, id, i], written in the same atomic commit as
// their head. A chunk set is never changed, only replaced under a new id and deleted, so a reader that finds a
// chunk missing knows a newer write landed and reads again.
export const CHUNK = 60_000;
const MAX_CHUNKS = 12; // one atomic commit is capped at 800 KiB
const MAX_METADATA = 1024;
const ROUNDS = 5;
const enc = new TextEncoder();
const dec = new TextDecoder();

const headKey = key => ['s', key];
const chunkKey = (key, id, i) => ['c', key, id, i];

function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

// The first string that sorts after every string starting with `prefix`.
const after = prefix => prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1);

export function kvStore(kv, { now = Date.now } = {}) {
  const live = head => head !== null && (head.x === null || head.x > now());

  async function heads(keys) {
    const out = new Map();
    for (let i = 0; i < keys.length; i += 10) {
      const batch = keys.slice(i, i + 10);
      (await kv.getMany(batch.map(headKey))).forEach((entry, j) => out.set(batch[j], entry));
    }
    return out;
  }

  // The text a live head points at, or undefined when its chunk set is gone.
  async function text(key, head) {
    if (!head.n) return dec.decode(head.v);
    const keys = Array.from({ length: head.n }, (_, i) => chunkKey(key, head.id, i));
    const parts = [];
    for (let i = 0; i < keys.length; i += 10) {
      for (const entry of await kv.getMany(keys.slice(i, i + 10))) {
        if (entry.value === null) return undefined;
        parts.push(entry.value);
      }
    }
    return dec.decode(concat(parts));
  }

  async function getEntry(key) {
    for (let round = 0; round < ROUNDS; round++) {
      const entry = await kv.get(headKey(key));
      if (!live(entry.value)) return { value: null, version: entry.versionstamp };
      const value = await text(key, entry.value);
      if (value !== undefined) return { value, version: entry.versionstamp };
    }
    throw new Error(`KV value for ${key} is missing chunks`);
  }

  async function get(key, type = 'text') {
    const { value } = await getEntry(key);
    if (value === null) return null;
    return (typeof type === 'object' ? type?.type : type) === 'json' ? JSON.parse(value) : value;
  }

  function dropChunks(op, key, old) {
    for (let i = 0; i < (old?.n ?? 0); i++) op.delete(chunkKey(key, old.id, i));
  }

  function addPut(op, key, value, opts = {}, old) {
    const bytes = enc.encode(String(value));
    const m = opts.metadata ?? null;
    if (m !== null && enc.encode(JSON.stringify(m)).length > MAX_METADATA) throw new Error(`KV metadata for ${key} is over ${MAX_METADATA} bytes`);
    const ttl = opts.expirationTtl ? opts.expirationTtl * 1000 : null;
    const x = ttl === null ? null : now() + ttl;
    const options = ttl === null ? undefined : { expireIn: ttl };
    if (bytes.length <= CHUNK) {
      op.set(headKey(key), { v: bytes, m, x, n: 0, id: null }, options);
    } else {
      const n = Math.ceil(bytes.length / CHUNK);
      if (n > MAX_CHUNKS) throw new Error(`KV value for ${key} is over ${MAX_CHUNKS * CHUNK} bytes`);
      const id = crypto.randomUUID();
      // slice copies: a subarray view would serialize its whole backing buffer.
      for (let i = 0; i < n; i++) op.set(chunkKey(key, id, i), bytes.slice(i * CHUNK, (i + 1) * CHUNK), options);
      op.set(headKey(key), { v: null, m, x, n, id }, options);
    }
    dropChunks(op, key, old);
  }

  // One atomic write. `checks` compare a key's version (from getEntry) with what is stored now; on a mismatch
  // nothing is written and the result is false. Keys being written are also guarded, so the chunk sets deleted are
  // always the current ones; a clash on those alone is retried.
  async function commit({ checks = [], puts = [], deletes = [] } = {}) {
    const keys = [...new Set([...puts.map(p => p.key), ...deletes])];
    for (let round = 0; round < ROUNDS; round++) {
      const old = await heads(keys);
      const op = kv.atomic();
      for (const { key, version } of checks) op.check({ key: headKey(key), versionstamp: version ?? null });
      for (const key of keys) if (!checks.some(ch => ch.key === key)) op.check(old.get(key));
      for (const { key, value, opts } of puts) addPut(op, key, value, opts, old.get(key).value);
      for (const key of deletes) { op.delete(headKey(key)); dropChunks(op, key, old.get(key).value); }
      if ((await op.commit()).ok) return true;
      if (checks.length) {
        const current = await heads(checks.map(ch => ch.key));
        if (checks.some(ch => current.get(ch.key).versionstamp !== (ch.version ?? null))) return false;
      }
    }
    throw new Error('KV write kept conflicting');
  }

  async function list({ prefix = '', cursor, limit = 1000 } = {}) {
    const selector = prefix ? { start: headKey(prefix), end: headKey(after(prefix)) } : { prefix: ['s'] };
    const iter = kv.list(selector, { limit, cursor });
    const keys = [];
    let seen = 0;
    for await (const entry of iter) {
      seen++;
      if (live(entry.value)) keys.push(entry.value.m === null ? { name: entry.key[1] } : { name: entry.key[1], metadata: entry.value.m });
    }
    return seen < limit ? { keys, list_complete: true } : { keys, list_complete: false, cursor: iter.cursor };
  }

  return {
    get,
    getEntry,
    list,
    commit,
    put: async (key, value, opts) => { await commit({ puts: [{ key, value, opts }] }); },
    delete: async key => { await commit({ deletes: [key] }); },
  };
}
