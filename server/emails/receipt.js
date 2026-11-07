import { esc, money, jamaicaTime, chargeRows, addressLines } from './html.js';
import { C, DISPLAY, BODY, MONO, mono, button, chip, block, shell } from './brand.js';

const rule = `border-bottom:1px solid ${C.char}`;
const text = (html, color = C.bone, size = 15) => `<div style="font-family:${BODY};font-size:${size}px;line-height:1.55;color:${color}">${html}</div>`;
const label = t => `<div style="padding-bottom:8px">${mono(t)}</div>`;

function itemRows(lines) {
  return lines.map(l => `<tr>
    <td valign="top" style="padding:14px 0;${rule}">
      <div style="font-family:${DISPLAY};font-size:14px;line-height:1.2;text-transform:uppercase;color:${C.bone}">${esc(l.name)}</div>
      <div style="padding-top:4px">${mono(`${esc(l.color)} / ${esc(l.size)}`)}</div>
      <div style="padding-top:4px">${mono(`${l.qty} &times; ${money(l.unitCents)}`, C.smoke, 12)}</div>
    </td>
    <td valign="top" align="right" width="96" style="padding:14px 0;${rule};font-family:${MONO};font-size:14px;color:${C.bone};white-space:nowrap">${money(l.qty * l.unitCents)}</td>
  </tr>`).join('');
}

function chargeTable(r) {
  const rows = chargeRows(r);
  return rows.map(([k, v], i) => (i === rows.length - 1
    ? `<tr><td style="padding:16px 0 0;border-top:2px solid ${C.bone};font-family:${DISPLAY};font-size:16px;letter-spacing:1px;text-transform:uppercase;color:${C.bone}">${esc(k)}</td>
       <td align="right" style="padding:16px 0 0;border-top:2px solid ${C.bone};font-family:${DISPLAY};font-size:18px;color:${C.hazard};white-space:nowrap">${esc(v)}</td></tr>`
    : `<tr><td style="padding:6px 0;font-family:${BODY};font-size:14px;color:${C.smoke}">${esc(k)}</td>
       <td align="right" style="padding:6px 0;font-family:${MONO};font-size:14px;color:${C.bone};white-space:nowrap">${esc(v)}</td></tr>`)).join('');
}

function fulfilment(r) {
  if (r.fulfillment?.type === 'pickup') {
    const loc = r.fulfillment.location;
    return `${label('Pickup')}${text(`<b>${esc(loc.name)}</b><br>${esc(loc.address ?? loc.area)}`)}
      <div style="padding-top:10px">${text('We will contact you when your order is ready and confirm the pickup details.', C.smoke, 13)}</div>`;
  }
  if (!r.address) return '';
  return `${label('Shipping to')}${text(addressLines(r.address).map(esc).join('<br>'))}
    <div style="padding-top:10px">${text("We'll contact you about shipping cost and timing.", C.smoke, 13)}</div>`;
}

// From a revealed, paid order (revealOrder). `site` is the store's URL, for the logo and policy link.
export function receiptEmail(r, site) {
  const first = r.customer?.firstName;
  const where = fulfilment(r);
  const total = `${money(r.totalCents)} USD`;
  const body = [
    block(`${chip(r.payment ? '&#10003; Paid' : 'Order placed')}
      <div style="padding-top:16px;font-family:${DISPLAY};font-size:26px;line-height:1.05;text-transform:uppercase;color:${C.bone}">${first ? `Thanks, ${esc(first)}.` : 'Thanks for your order.'}</div>
      <div style="padding-top:10px">${text('Here is your receipt. Keep it for pickup, shipping and refunds.', C.smoke)}</div>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:20px;background:${C.ash};border:1px solid ${C.char}"><tr><td style="padding:14px 16px">
        ${mono('Order reference')}
        <div style="padding-top:4px;font-family:${MONO};font-size:18px;letter-spacing:1px;color:${C.bone}">${esc(r.id)}</div>
        ${r.payment ? `<div style="padding-top:12px">${mono('Paid')}</div>
        <div style="padding-top:4px;font-family:${BODY};font-size:14px;color:${C.bone}">${esc(jamaicaTime(r.payment.paidAt))} (Jamaica time)</div>
        <div style="padding-top:12px">${mono('WiPay transaction')}</div>
        <div style="padding-top:4px;font-family:${MONO};font-size:12px;color:${C.bone};word-break:break-all">${esc(r.payment.transactionId)}</div>` : ''}
      </td></tr></table>`, C.ink, '28px 24px 8px'),
    block(`${label('Your order')}
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="table-layout:fixed;border-top:1px solid ${C.char}">${itemRows(r.lines)}</table>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:12px">${chargeTable(r)}</table>`, C.ink, '20px 24px'),
    where ? block(where, C.ink, '12px 24px 20px') : '',
    block(`${text(`You can ask for a refund within 24 hours of this payment: see the <a href="${esc(site)}/policies.html#refund" style="color:${C.bone}">refund policy</a>. The processing fee is non-refundable.`, C.smoke, 13)}
      <div style="padding:16px 0 20px">${text('Questions about your order? DM @evincus.sw on Instagram with your order reference.', C.smoke, 13)}</div>
      ${button('https://www.instagram.com/evincus.sw/', 'Message us')}`, C.ink, '12px 24px 32px'),
  ].join('');
  return {
    subject: `Your Evincus order ${r.id}`,
    html: shell({
      title: 'thanks for your order',
      kicker: 'Order receipt',
      preview: `Order ${r.id} · ${total}${r.fulfillment?.type === 'pickup' ? ` · pickup at ${r.fulfillment.location.name}` : ''}`,
      site,
      body,
      footerNote: `You're getting this because you placed order ${esc(r.id)} at Evincus.`,
    }),
  };
}
