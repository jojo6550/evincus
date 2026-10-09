// Real Deno KV, in memory, for Node tests (the @deno/kv npm package). Tests skip when its native build is missing
// on this machine; CI must run them, so there a missing build is an error.
let openKv;
try { ({ openKv } = await import('@deno/kv')); } catch { /* not installed for this platform */ }
if (!openKv && process.env.CI) throw new Error('@deno/kv failed to load in CI');

export const skip = openKv ? false : '@deno/kv native build not available';

export async function memoryKv(t) {
  const kv = await openKv();
  t.after(() => kv.close());
  return kv;
}
