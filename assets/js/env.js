// Public site settings. config.js is gitignored and written by CI, so it can be missing
// (for example when Pages serves the branch directly). Fall back to defaults instead of
// letting a missing file stop every module that imports this one.
const cfg = await import('./config.js').catch(() => ({}));

export const PAYPAL_CLIENT_ID = cfg.PAYPAL_CLIENT_ID ?? 'test';
// '' means same origin; with no API there, the site falls back to the bundled catalog.
export const API_BASE = cfg.API_BASE ?? '';
