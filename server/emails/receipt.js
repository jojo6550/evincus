import { esc, money, layout } from './html.js';

export function receiptEmail(r) {
  const items = r.lines.map(l =>
    `<tr><td>${esc(l.name)}<br>${esc(l.color)} / ${esc(l.size)}</td><td align="right">${l.qty} × ${money(l.unitCents)}</td></tr>`).join('');
  return {
    subject: `Your Evincus order ${r.id}`,
    html: layout('Thanks for your order', `
<p>Your order is placed. No payment was collected at checkout.</p>
<table width="100%">
${items}
<tr><td>Subtotal</td><td align="right">${money(r.subtotalCents)}</td></tr>
<tr><th align="left">Total</th><th align="right">${money(r.totalCents)} USD</th></tr>
</table>
${r.fulfillment?.type === 'pickup' ? `<h2>Pickup</h2><p>${esc(r.fulfillment.location.name)}<br>${esc(r.fulfillment.location.address ?? r.fulfillment.location.area)}</p><p>We will contact you when your order is ready and confirm the pickup details.</p>` : ''}
<p>Order reference: ${esc(r.id)}</p>
<p>Questions about your order? DM @evincus.sw on Instagram with your order reference.</p>`),
  };
}
