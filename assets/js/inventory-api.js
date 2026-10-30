// Fetch client for /api/inventory/*. No DOM at import time, so Node tests can load it.
export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error?.message ?? "Can't reach the server. Check your connection and try again.");
    this.status = status;
    this.code = body?.error?.code ?? 'network';
    this.details = body?.error?.details ?? null;
    this.requestId = body?.error?.requestId ?? null;
  }
}

const listeners = new Set();
export const onSignedOut = fn => { listeners.add(fn); return () => listeners.delete(fn); };
export const newOpId = () => crypto.randomUUID();

// Writes always carry an opId; pass one to reuse it across retries. `timeout` is in ms (uploads may need longer).
export async function api(method, path, body, { opId, timeout = 30000 } = {}) {
  const write = method !== 'GET';
  let res;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body !== undefined || write ? { 'Content-Type': 'application/json' } : {},
      body: write ? JSON.stringify({ ...body, opId: opId ?? newOpId() }) : undefined,
      signal: AbortSignal.timeout(timeout), // a hung request ends as a network error (status 0), never a spinner forever
    });
  } catch {
    throw new ApiError(0, null);
  }
  if (res.status === 204) return null;
  let data = null;
  try { data = await res.json(); } catch { /* error built below */ }
  if (!res.ok || data === null) {
    const err = new ApiError(res.ok ? 0 : res.status, data);
    // A wrong password is also a 401 from the login route, but the person is not "signed out" of anything.
    if (err.status === 401 && path !== '/api/inventory/login') listeners.forEach(fn => fn(err));
    throw err;
  }
  return data;
}
