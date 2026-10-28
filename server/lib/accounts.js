import { HttpError } from './http.js';

export const ROLES = ['owner', 'viewer'];
export const ITERATIONS = 600000;
export const SESSION_TTL = 604800;
export const COOKIE = 'evincus_inv';

const DUMMY_SALT = 'ZXZpbmN1cy1kdW1teS1zYWx0'; // unknown emails still pay for one PBKDF2
const enc = new TextEncoder();
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const sha256Hex = async s => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));

export const accountKey = email => 'account:' + email.trim().toLowerCase();

export async function hashPassword(password, saltB64, iterations = ITERATIONS) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const salt = Uint8Array.from(atob(saltB64), ch => ch.charCodeAt(0));
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
  return btoa(String.fromCharCode(...new Uint8Array(bits)));
}

// Compares digests of both sides so length and early mismatch don't leak.
async function sameSecret(a, b) {
  const [x, y] = await Promise.all([sha256Hex(a), sha256Hex(b)]);
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return d === 0;
}

export async function verifyLogin(env, email, password) {
  const account = await env.ORDERS.get(accountKey(String(email ?? '')), 'json');
  const hash = await hashPassword(String(password ?? ''), account?.salt ?? DUMMY_SALT, account?.iterations ?? ITERATIONS);
  return account && await sameSecret(hash, account.hash) ? account : null;
}

export async function startSession(env, account, now) {
  const token = hex(crypto.getRandomValues(new Uint8Array(32)));
  const session = { email: account.email, epoch: account.epoch, expiresAt: now + SESSION_TTL * 1000 };
  await env.ORDERS.put('session:' + await sha256Hex(token), JSON.stringify(session), { expirationTtl: SESSION_TTL });
  return token;
}

const attrs = 'HttpOnly; SameSite=Strict; Path=/';
export const sessionCookie = (token, secure) => `${COOKIE}=${token}; ${attrs}; Max-Age=${SESSION_TTL}${secure ? '; Secure' : ''}`;
export const clearCookie = secure => `${COOKIE}=; ${attrs}; Max-Age=0${secure ? '; Secure' : ''}`;

// Render terminates TLS, so the app sees http://localhost plus x-forwarded-proto.
export const isHttps = req => req.headers.get('x-forwarded-proto') === 'https' || new URL(req.url).protocol === 'https:';

function cookieToken(req) {
  for (const part of (req.headers.get('cookie') ?? '').split(';')) {
    const i = part.indexOf('=');
    if (part.slice(0, i).trim() === COOKIE) return part.slice(i + 1).trim();
  }
  return null;
}

export async function staffFrom(req, env) {
  const token = cookieToken(req);
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
  const sessionKey = 'session:' + await sha256Hex(token);
  const session = await env.ORDERS.get(sessionKey, 'json');
  if (!session || session.expiresAt <= Date.now()) return null;
  const account = await env.ORDERS.get(accountKey(session.email), 'json');
  if (!account || account.epoch !== session.epoch) return null;
  return { email: account.email, role: account.role, sessionKey };
}

function sameOrigin(req, env) {
  let origin;
  try { origin = new URL(req.headers.get('origin') ?? ''); } catch { return false; }
  if (env.ENVIRONMENT === 'production' && origin.protocol !== 'https:') return false;
  return origin.host === (req.headers.get('host') ?? new URL(req.url).host);
}

export async function requireStaff(req, c, { role = 'viewer', write = false } = {}) {
  const staff = await staffFrom(req, c.env);
  if (!staff) throw new HttpError('signed-out', 401);
  if (role === 'owner' && staff.role !== 'owner') throw new HttpError('forbidden', 403);
  if (write && !sameOrigin(req, c.env)) throw new HttpError('bad-origin', 403);
  return { email: staff.email, role: staff.role };
}
