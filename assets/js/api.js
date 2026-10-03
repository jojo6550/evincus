import { API_BASE } from './config.js';

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error?.message ?? "Can't reach the store right now. Check your connection and try again.");
    this.status = status;
    this.code = body?.error?.code ?? 'network';
    this.reqId = body?.error?.requestId ?? null;
    this.body = body;
  }
}

export async function api(method, path, body) {
  let res;
  try {
    res = await fetch(API_BASE + path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, null);
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

// Fire-and-forget checkout error report. text/plain avoids a CORS preflight.
export function beacon(event, fields = {}) {
  try {
    const body = JSON.stringify({ event, route: (location.hash || '#/').slice(0, 200), ...fields });
    const blob = new Blob([body], { type: 'text/plain' });
    if (!navigator.sendBeacon?.(API_BASE + '/api/beacon', blob)) {
      fetch(API_BASE + '/api/beacon', { method: 'POST', body: blob, keepalive: true }).catch(() => {});
    }
  } catch { /* reporting must never break the page */ }
}

export function beaconOnce(event, fields) {
  try {
    const key = `evincus_beacon_${event}`;
    if (sessionStorage.getItem(key)) return;
    sessionStorage.setItem(key, '1');
  } catch { /* storage blocked: report anyway */ }
  beacon(event, fields);
}
