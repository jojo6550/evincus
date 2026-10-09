import { money, layout, table } from './html.js';
import { recordRows } from '../lib/orders.js';

export function ownerEmail(r) {
  return {
    subject: `New order ${r.id}: ${money(r.totalCents)}`,
    html: layout(`New order ${r.id}`, table(recordRows(r))),
  };
}
