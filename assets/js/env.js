// Public site settings. The server generates config.js from its environment (server/static.js); when the site is
// opened without that server (a plain file server), the import fails and these defaults apply instead of
// stopping every module that imports this one.
const cfg = await import('./config.js').catch(() => ({}));

export const PAYPAL_CLIENT_ID = cfg.PAYPAL_CLIENT_ID ?? 'test';
// '' means same origin; with no API there, the site falls back to the bundled catalog.
export const API_BASE = cfg.API_BASE ?? '';
