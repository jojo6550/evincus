import { json } from './http.js';
import { saveOrder, ORDER_TTL } from './orders.js';

// One Durable Object per browser checkout token. Serialization and strongly consistent
// storage ensure double clicks and network retries cannot create duplicate orders.
export class OrderSubmission {
  constructor(state, env) { this.state = state; this.env = env; }

  async fetch(req) {
    const { fingerprint, record } = await req.json();
    return this.state.blockConcurrencyWhile(async () => {
      let saved = await this.state.storage.get('submission');
      if (saved && saved.fingerprint !== fingerprint) return json({ conflict: true }, 409);
      if (!saved && !record) return json({ record: null });
      if (!saved) {
        saved = { fingerprint, record, indexed: false };
        await this.state.storage.put('submission', saved);
        await this.state.storage.setAlarm(Date.now() + ORDER_TTL * 1000);
      }
      if (!saved.indexed) {
        await saveOrder(this.env, saved.record);
        // Persist the retry job before acknowledging the order, so a Worker shutdown
        // after responding cannot silently lose the customer confirmation.
        await this.env.ORDERS.put(`email-retry:${saved.record.id}`, JSON.stringify({ retries: 0, nextAt: Date.parse(saved.record.placedAt) }));
        saved.indexed = true;
        await this.state.storage.put('submission', saved);
      }
      return json({ record: saved.record });
    });
  }

  async alarm() { await this.state.storage.deleteAll(); }
}
