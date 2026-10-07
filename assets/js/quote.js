// The server's view of the bag: prices, availability and totals. The bag UI and checkout render from this.
import { api, beacon } from './api.js';
import * as cart from './cart.js';

const COUNTED = new Set(['ok', 'qty-capped']);
let state = { status: 'idle', quote: null, error: null };
const listeners = new Set();
let timer = null;
let seq = 0;

const emit = () => listeners.forEach(fn => fn(state));

export const current = () => state;
export const onQuote = fn => { listeners.add(fn); };
export const isCheckoutReady = () => state.status === 'ready' && state.quote?.checkoutReady === true;
export const unavailableKeys = () => (state.quote?.lines ?? []).filter(l => !COUNTED.has(l.status)).map(l => l.key);

export async function refreshQuote() {
  clearTimeout(timer);
  const mine = ++seq;
  const items = cart.rawItems().map(({ id, color, size, qty }) => ({ id, color, size, qty }));
  if (!items.length) {
    state = { status: 'ready', quote: null, error: null };
    emit();
    return state;
  }
  state = { ...state, status: 'loading' };
  emit();
  try {
    const quote = await api('POST', '/api/bag/quote', { items });
    if (mine === seq) state = { status: 'ready', quote, error: null };
  } catch (err) {
    if (mine === seq) {
      state = { status: 'error', quote: null, error: err };
      beacon('quote-failed', { code: err.code, ...(err.reqId ? { reqId: err.reqId } : {}) });
    }
  }
  if (mine === seq) emit();
  return state;
}

export function scheduleQuote() {
  clearTimeout(timer);
  // Disable checkout as soon as the cart changes, including during the debounce.
  // Invalidate any request for the old cart so it cannot restore a stale quote.
  ++seq;
  state = { ...state, status: 'loading' };
  emit();
  timer = setTimeout(refreshQuote, 300);
}
