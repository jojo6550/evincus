import { HttpError } from './http.js';

// Client-minted operation ids make a retried write apply once: the first result is kept for a week.
export const OP_TTL = 604800;
export const isOpId = v => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v ?? '');
export const opKey = opId => 'op:' + opId;
// `kind` names the write (stock, product, era, era-order, order-action), so one id never replays across endpoints.
// -> { result } when the op already ran as `kind`, else { check } to put in the commit so a racing twin fails it and
// retries. An id used by another kind is 409 op-reused.
export async function readOpEntry(env, opId, kind) {
  const { value, version } = await env.ORDERS.getEntry(opKey(opId));
  if (!value) return { check: { key: opKey(opId), version } };
  const op = JSON.parse(value);
  if (op.kind !== kind) throw new HttpError('op-reused', 409);
  return { result: op.result };
}
// For a commit's puts, so the result lands atomically with the change it describes.
export const opPut = (opId, kind, result) => ({ key: opKey(opId), value: JSON.stringify({ kind, result }), opts: { expirationTtl: OP_TTL } });
