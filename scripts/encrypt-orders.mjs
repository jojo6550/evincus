// One-off, idempotent: seals the customer details of orders placed before encryption, and their submission copies,
// in place: `npm run encrypt-orders`. Run once after CUSTOMER_DATA_KEY is set. Safe to run again: sealed records are
// skipped, and every write is version-checked, so a record changed meanwhile is re-read, never overwritten.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openKv } from '@deno/kv';
import { kvStore } from '../server/lib/kv-store.js';
import { changeOrder, revealOrder, ORDER_TTL } from '../server/lib/orders.js';
import { submissionKey } from '../server/lib/submissions.js';
import { PERSONAL_FIELDS } from '../server/lib/retention.js';
import { seal } from '../server/lib/crypto.js';

const plain = r => !!r && PERSONAL_FIELDS.some(f => f !== 'pii' && f in r);

// The record with its personal fields moved into `pii`.
async function sealed(env, r) {
  const { customer, address, notes } = await revealOrder(env, r);
  const out = { ...r };
  for (const f of PERSONAL_FIELDS) delete out[f];
  const { name, ...rest } = customer ?? {};
  return { ...out, pii: await seal(env, { customer: customer ? rest : null, address: address ?? null, notes: notes ?? '' }) };
}

async function sealSubmission(env, id) {
  for (let round = 0; round < 5; round++) {
    const { value, version } = await env.ORDERS.getEntry(submissionKey(id));
    const saved = value && JSON.parse(value);
    if (!plain(saved?.record)) return false;
    const next = { ...saved, record: await sealed(env, saved.record) };
    // kvStore can't read a key's remaining TTL, so the copy gets the full order lifetime.
    if (await env.ORDERS.commit({ checks: [{ key: submissionKey(id), version }], puts: [{ key: submissionKey(id), value: JSON.stringify(next), opts: { expirationTtl: ORDER_TTL } }] })) return true;
  }
  throw new Error(`submission:${id} kept changing; run again`);
}

export async function encryptOrders(env) {
  let scanned = 0, n = 0, cursor;
  do {
    const page = await env.ORDERS.list({ prefix: 'order:', cursor });
    for (const { name } of page.keys) {
      const id = name.slice('order:'.length);
      scanned++;
      let did = false; // `change` reruns on a version clash, so count after the commit
      await changeOrder(env, id, async r => { did = plain(r); return did ? sealed(env, r) : null; });
      if (did) n++;
      if (await sealSubmission(env, id)) n++;
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return { scanned, sealed: n };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const kv = await openKv(process.env.KV_PATH ?? '.kv.sqlite3');
  try {
    const result = await encryptOrders({ ORDERS: kvStore(kv), CUSTOMER_DATA_KEY: process.env.CUSTOMER_DATA_KEY });
    console.log(`Checked ${result.scanned} orders; sealed ${result.sealed} records.`);
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  } finally {
    kv.close();
  }
}
