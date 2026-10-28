// Stock is one document per product, `stock:<productId>` → { '<colour>|<size>': { onHand, committed } }, so a
// checkout or stock save checks one key per product, within @deno/kv's 10 checks per commit. No metadata: a
// document can outgrow its 1 KiB.
export const stockKey = productId => 'stock:' + productId;

// Value for a commit put, from the document as an object or a Map.
export const stockDoc = doc => JSON.stringify(doc instanceof Map ? Object.fromEntries(doc) : doc);

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
  const names = (await listAll(env.ORDERS, 'stock:')).map(k => k.name);
  const docs = await Promise.all(names.map(name => env.ORDERS.get(name, 'json')));
  const out = new Map();
  names.forEach((name, i) => {
    for (const [variant, s] of Object.entries(docs[i] ?? {})) out.set(`${name.slice('stock:'.length)}|${variant}`, { onHand: s.onHand ?? 0, committed: s.committed ?? 0 });
  });
  return out;
}
