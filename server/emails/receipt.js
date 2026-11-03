import { esc, money, layout, jamaicaTime, chargeRows, addressLines } from './html.js';

// From a revealed, paid order (revealOrder). `site` is the store's URL, for the policy link.
export function receiptEmail(r, site) {
  const items = r.lines.map(l =>
    `<tr><td>${esc(l.name)}<br>${esc(l.color)} / ${esc(l.size)}</td><td align="right">${l.qty} × ${money(l.unitCents)}</td></tr>`).join('');
  const rows = chargeRows(r).map(([k, v], i, all) => (i === all.length - 1
    ? `<tr><th align="left">${esc(k)}</th><th align="right">${esc(v)}</th></tr>`
    : `<tr><td>${esc(k)}</td><td align="right">${esc(v)}</td></tr>`)).join('');
  const where = r.fulfillment?.type === 'pickup'
    ? `<h2>Pickup</h2><p>${esc(r.fulfillment.location.name)}<br>${esc(r.fulfillment.location.address ?? r.fulfillment.location.area)}</p><p>We will contact you when your order is ready and confirm the pickup details.</p>`
    : r.address ? `<h2>Shipping to</h2><p>${addressLines(r.address).map(esc).join('<br>')}</p><p>We'll contact you about shipping cost and timing.</p>` : '';
  const paid = r.payment ? `<p>Paid ${esc(jamaicaTime(r.payment.paidAt))} (Jamaica time). WiPay transaction ${esc(r.payment.transactionId)}.</p>` : '';
  return {
    subject: `Your Evincus order ${r.id}`,
    html: layout('Thanks for your order', `
${paid}
<table width="100%">
${items}
${rows}
</table>
${where}
<p>Order reference: ${esc(r.id)}</p>
<p>You can ask for a refund within 24 hours of this payment: see the <a href="${esc(site)}/policies.html#refund">refund policy</a>. The processing fee is non-refundable.</p>
<p>Questions about your order? DM @evincus.sw on Instagram with your order reference.</p>`),
  };
}
