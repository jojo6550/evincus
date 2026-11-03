// Plain HTML for email: no styles, so every client renders it the same way.
import { money } from '../../data/catalog.js';

export { money };

export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const layout = (title, body) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title></head><body><h1>${esc(title)}</h1>${body}</body></html>`;

export const table = rows =>
  `<table>${rows.map(([k, v]) => `<tr><th align="left">${esc(k)}</th><td>${esc(v)}</td></tr>`).join('')}</table>`;

const JAMAICA = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Jamaica', dateStyle: 'medium', timeStyle: 'short' });
export const jamaicaTime = iso => JAMAICA.format(new Date(iso));

const pct = bps => `${bps / 100}%`;
// Subtotal, GCT, processing fee and total, from the rates stored on the order. Legacy orders have no tax or fee.
export const chargeRows = r => [
  ['Subtotal', money(r.subtotalCents)],
  ...(r.taxCents != null ? [[`GCT (${pct(r.taxBps)})`, money(r.taxCents)]] : []),
  ...(r.feeCents != null ? [[`Processing fee (${pct(r.feeBps)}, non-refundable)`, money(r.feeCents)]] : []),
  ['Total', `${money(r.totalCents)} USD`],
];

const REGIONS = new Intl.DisplayNames('en', { type: 'region' });
export const addressLines = a => [a.line1, a.line2, [a.city, a.region, a.postalCode].filter(Boolean).join(', '), REGIONS.of(a.country)].filter(Boolean);
