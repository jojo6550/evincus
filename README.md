# Evincus storefront

Static single-page store for Evincus. No build step: vanilla ES modules, hash routing, PayPal JS SDK checkout.
Structure follows the Newborn Initiative site (`pages/*.js` render/init modules, `assets/js/paypal.js` lazy SDK loader).

## Run locally

ES modules don't load from `file://`, and checkout needs the `/api` functions, so use the Netlify CLI:

```bash
npm i -g netlify-cli
netlify dev
```

Then open the URL it prints (http://localhost:8888). Product browsing works with any static server
(`python -m http.server 5173`), but PayPal checkout needs `netlify dev`.

## Setup before launch

1. Copy `assets/js/config.example.js` to `assets/js/config.js`.
2. Set `PAYPAL_CLIENT_ID` (Sandbox ID to test, Live ID to sell). `'test'` only renders PayPal's demo sandbox.
3. Set `SHIPPING_USD` to your flat shipping rate (0 shows "Free").
4. Product data lives in `data/products.js`. Images currently load from the Shopify CDN; download them into `images/` before cancelling Shopify.
5. Deploy to Netlify and set these environment variables (Site settings → Environment variables), or put them in a
   gitignored `.env` for `netlify dev`:

   | Variable | Value |
   | --- | --- |
   | `PAYPAL_CLIENT_ID` | Same client ID as `config.js` |
   | `PAYPAL_CLIENT_SECRET` | App secret from developer.paypal.com. Never commit it |
   | `PAYPAL_ENV` | `sandbox` (default) or `live` |
   | `SHIPPING_USD` | Must match `SHIPPING_USD` in `config.js` |

## Payments

The browser sends only product id, colour, size and quantity. Two Netlify functions do the rest:

- `POST /api/orders` (`netlify/functions/create-order.mjs`) prices the cart from `data/products.js`, creates the PayPal
  order with server credentials, and tags it with an HMAC only the server can produce.
- `POST /api/orders/capture` (`netlify/functions/capture-order.mjs`) re-reads the order from PayPal, refuses it unless
  the tag matches the amount PayPal holds, captures it, and checks the captured amount.

Prices therefore can't be altered from the browser, and orders created outside the server can't be captured through it.

## Tests

```bash
node --test tests/orders.test.mjs
```
