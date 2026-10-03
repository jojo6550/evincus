import { SHIPPING_USD } from './config.js';
import * as cart from './cart.js';

export function orderTotals() {
  const lines = cart.lines();
  const subtotal = lines.reduce((n, l) => n + l.price * l.qty, 0);
  const shipping = lines.length ? SHIPPING_USD : 0;
  return { lines, subtotal, shipping, total: subtotal + shipping };
}
