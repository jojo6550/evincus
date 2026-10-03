// Copy this file to config.js and fill in your values.
// config.js is gitignored; CI writes it from repository variables at deploy.

// PayPal Client ID — developer.paypal.com → Apps & Credentials.
// Use the Sandbox ID while testing, the Live ID in production. Must match the Worker's PAYPAL_CLIENT_ID.
export const PAYPAL_CLIENT_ID = 'test';

// Where the API runs, with no trailing slash. Local: http://localhost:8787.
// Production: https://api.evincus.shop (or the workers.dev URL). Same-origin hosting later: ''.
export const API_BASE = 'http://localhost:8787';
