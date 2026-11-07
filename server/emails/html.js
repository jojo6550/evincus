// Shared email helpers. layout and table frame the staff emails (alerts, daily summary) in the brand shell.
import { money } from '../../data/catalog.js';
import { C, BODY, block, shell } from './brand.js';

export { money };

export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const layout = (title, body) => shell({
  title, kicker: 'Staff', preview: title,
  body: block(`<div style="font-family:${BODY};font-size:14px;line-height:1.5;color:${C.bone}">${body}</div>`),
  footerNote: 'Internal Evincus email for the store team.',
});

// Fonts and colours come from layout's wrapper; per-cell styles stay tiny so a 20-order summary stays under Gmail's 102KB clip.
export const table = rows =>
  `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 16px">${rows.map(([k, v]) => `<tr><th align="left" valign="top" width="36%" style="padding:6px 8px 6px 0;color:${C.smoke};font-weight:normal">${esc(k)}</th><td valign="top" style="padding:6px 0;word-break:break-word">${esc(v)}</td></tr>`).join('')}</table>`;

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
