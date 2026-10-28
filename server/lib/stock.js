// Stock lives under `stock:<lineKey>`; the value and the list metadata both carry { onHand, committed }.
export const stockKey = lineKey => 'stock:' + lineKey;

// Entry for use inside a commit.
export const stockEntry = (onHand, committed) => ({ value: JSON.stringify({ onHand, committed }), opts: { metadata: { onHand, committed } } });

// Pages through every key under a prefix.
export async function listAll(kv, prefix) {
  const keys = [];
  let cursor;
  for (;;) {
    const page = await kv.list({ prefix, cursor });
    keys.push(...page.keys);
    if (page.list_complete) return keys;
    cursor = page.cursor;
  }
}

export async function loadStock(env) {
  const out = new Map();
  for (const { name, metadata } of await listAll(env.ORDERS, 'stock:')) out.set(name.slice('stock:'.length), { onHand: metadata?.onHand ?? 0, committed: metadata?.committed ?? 0 });
  return out;
}
