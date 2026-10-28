// Client-minted operation ids make a retried write apply once: the first result is kept for a week.
export const OP_TTL = 604800;
export const isOpId = v => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v ?? '');
export const opKey = opId => 'op:' + opId;
// -> { result } when the op already ran, else { check } to put in the commit so a racing twin fails it and retries.
export async function readOpEntry(env, opId) {
  const { value, version } = await env.ORDERS.getEntry(opKey(opId));
  return value ? { result: JSON.parse(value) } : { check: { key: opKey(opId), version } };
}
// For a commit's puts, so the result lands atomically with the change it describes.
export const opPut = (opId, result) => ({ key: opKey(opId), value: JSON.stringify(result), opts: { expirationTtl: OP_TTL } });
