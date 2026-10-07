import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.localStorage = { getItem: () => null, setItem: () => {} };
const cart = await import('../assets/js/cart.js');
const quotes = await import('../assets/js/quote.js');
const originalFetch = globalThis.fetch;
const reply = qty => new Response(JSON.stringify({ checkoutReady: true, lines: [{ qty }], totalCents: qty * 1000 }), { headers: { 'Content-Type': 'application/json' } });

test('cart changes immediately disable checkout and invalidate an in-flight old quote', async () => {
  try {
    cart.add('test-tee', 'Black', 'M');
    globalThis.fetch = async () => reply(1);
    await quotes.refreshQuote();
    assert.equal(quotes.isCheckoutReady(), true);

    let finishOldRequest;
    globalThis.fetch = () => new Promise(resolve => { finishOldRequest = resolve; });
    const oldRequest = quotes.refreshQuote();
    cart.setQty('test-tee|Black|M', 2);
    quotes.scheduleQuote();
    assert.equal(quotes.isCheckoutReady(), false);
    finishOldRequest(reply(1));
    await oldRequest;
    assert.equal(quotes.isCheckoutReady(), false);

    globalThis.fetch = async (url, init) => reply(JSON.parse(init.body).items[0].qty);
    await quotes.refreshQuote();
    assert.equal(quotes.isCheckoutReady(), true);
    assert.equal(quotes.current().quote.totalCents, 2000);
  } finally { globalThis.fetch = originalFetch; }
});
