import { SHIPPING_USD } from './config.js';
import * as cart from './cart.js';

// Display-only totals in cents. Replaced by the server quote in Task 11.
export function orderTotals() {
  const lines = cart.lines();
  const subtotal = lines.reduce((n, l) => n + l.totalCents, 0);
  const shipping = lines.length ? Math.round(SHIPPING_USD * 100) : 0;
  return { lines, subtotal, shipping, total: subtotal + shipping };
}
