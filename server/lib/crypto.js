// AES-256-GCM sealing for customer details at rest. Losing CUSTOMER_DATA_KEY loses every sealed record.
const b64 = bytes => Buffer.from(bytes).toString('base64');
const unb64 = s => new Uint8Array(Buffer.from(s, 'base64'));

export function validDataKey(key) {
  if (typeof key !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(key)) return false;
  return Buffer.from(key, 'base64').length === 32;
}

const keys = new Map(); // one import per distinct key value
export function dataKey(env) {
  const raw = env.CUSTOMER_DATA_KEY;
  if (!validDataKey(raw)) return Promise.reject(new Error('CUSTOMER_DATA_KEY must be 32 bytes, base64'));
  if (!keys.has(raw)) keys.set(raw, crypto.subtle.importKey('raw', unb64(raw), 'AES-GCM', false, ['encrypt', 'decrypt']));
  return keys.get(raw);
}

export const isSealed = x => !!x && typeof x === 'object' && x.v === 1 && typeof x.iv === 'string' && typeof x.ct === 'string';

export async function seal(env, value) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await dataKey(env), new TextEncoder().encode(JSON.stringify(value)));
  return { v: 1, iv: b64(iv), ct: b64(ct) };
}

export async function unseal(env, box) {
  if (!isSealed(box)) throw new Error('not a sealed value');
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(box.iv) }, await dataKey(env), unb64(box.ct));
  return JSON.parse(new TextDecoder().decode(plain));
}
