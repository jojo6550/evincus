# Evincus storefront

Static single-page store for Evincus. No build step: vanilla ES modules, hash routing, PayPal JS SDK checkout.
Structure follows the Newborn Initiative site (`pages/*.js` render/init modules, `assets/js/paypal.js` lazy SDK loader).

## Run locally

ES modules don't load from `file://`, so serve the folder:

```bash
python -m http.server 5173
```

Then open http://localhost:5173.

## Setup before launch

1. Copy `assets/js/config.example.js` to `assets/js/config.js`.
2. Set `PAYPAL_CLIENT_ID` (Sandbox ID to test, Live ID to sell). `'test'` only renders PayPal's demo sandbox.
3. Set `SHIPPING_USD` to your flat shipping rate (0 shows "Free").
4. Product data lives in `data/products.js`. Images currently load from the Shopify CDN; download them into `images/` before cancelling Shopify.

## Payments

Orders are created in the browser from the catalog in `data/products.js`. A technical buyer could alter the amount
before paying, so check each captured payment's amount in PayPal against the order before shipping. For automatic
protection, move order creation/capture to a small server (PayPal Orders v2 API).
