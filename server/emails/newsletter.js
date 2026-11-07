// "What's new" and confirm-subscription emails, in the branded frame (brand.js).
import { esc, money } from './html.js';
import { C, DISPLAY, BODY, MONO, MARKER, abs, mono, button, chip, block, shell } from './brand.js';

export const UNSUB = '%%UNSUBSCRIBE_URL%%';

const when = iso => new Date(iso).toLocaleString('en-US', { timeZone: 'America/Jamaica', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

const price = p => p.compareAtCents > p.priceCents
  ? `<span style="color:${C.smoke};text-decoration:line-through">${money(p.compareAtCents)}</span>&nbsp; <span style="color:${C.hazard}">${money(p.priceCents)}</span>`
  : money(p.priceCents);

const firstImage = p => p.colors?.[0]?.images?.[0] ?? p.images?.[0] ?? null;

function productGrid(products, site) {
  const cells = products.slice(0, 6).map(p => {
    const img = firstImage(p);
    return `<td width="50%" valign="top" style="padding:6px">
      <a href="${esc(`${site}/products/${p.id}`)}" style="text-decoration:none;color:${C.bone}">
        ${img ? `<img src="${esc(abs(site, img))}" width="264" alt="${esc(p.name)}" style="display:block;width:100%;max-width:100%;height:auto;background:${C.bone};border:0">` : ''}
        <div style="padding-top:10px;font-family:${DISPLAY};font-size:14px;text-transform:uppercase;color:${C.bone}">${esc(p.name)}</div>
        <div style="padding-top:4px;font-family:${MONO};font-size:13px;color:${C.bone}">${price(p)}</div>
      </a></td>`;
  });
  const rows = [];
  for (let i = 0; i < cells.length; i += 2) rows.push(`<tr>${cells[i]}${cells[i + 1] ?? '<td width="50%"></td>'}</tr>`);
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:18px;table-layout:fixed">${rows.join('')}</table>`;
}

const eraNames = (issue, slugs) => (slugs ? slugs.map(s => issue.eras.find(e => e.slug === s)?.name ?? s).join(' + ') : 'Everything');

function dropSection(d, site) {
  const e = d.era;
  return `${e.hero ? `<tr><td style="background:${C.ink};padding:0"><img src="${esc(abs(site, e.hero))}" width="600" alt="${esc(e.name)} collection" style="display:block;width:100%;max-width:100%;height:auto;border:0"></td></tr>` : ''}
  ${block(`${chip('&#9679; New drop &middot; live now')}
    <div style="padding-top:16px;font-family:${DISPLAY};font-size:36px;line-height:1;text-transform:uppercase;color:${C.bone}">${esc(e.name)}</div>
    ${e.tagline ? `<div style="padding-top:8px;font-family:${MARKER};font-size:22px;color:${C.hazard}">${esc(e.tagline)}</div>` : ''}
    ${e.story ? `<p style="margin:14px 0 0;font-family:${BODY};font-size:15px;line-height:1.55;color:${C.smoke}">${esc(e.story)}</p>` : ''}
    ${d.products.length ? productGrid(d.products, site) : ''}
    <div style="padding-top:22px">${button(`${site}/index.html#era-${e.slug}`, 'Shop the drop')}</div>`)}`;
}

function saleSection(s, issue, site, last = false) {
  return block(`
    ${mono(last ? '&#9888; Last call &middot; ends soon' : 'Sale &middot; on now', C.ink)}
    <div style="padding-top:8px;font-family:${MARKER};font-size:28px;color:${C.bone};line-height:1">${esc(s.label ?? 'sale')}</div>
    <div style="font-family:${DISPLAY};font-size:72px;line-height:1;letter-spacing:-2px;color:${C.ink}">&minus;${s.percent}%</div>
    <div style="padding-top:6px">${mono(esc(eraNames(issue, s.eras)), C.ink, 12)}</div>
    <div style="padding:14px 0 20px">${mono(`Ends ${esc(when(s.endsAt))} (Jamaica time)`, C.ink, 12)}</div>
    ${button(`${site}/index.html#shop`, 'Shop the sale', C.ink, C.hazard)}`, C.hazard);
}

function soonSection(e, site) {
  return block(`
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid ${C.char};background:${C.ash};table-layout:fixed"><tr>
      ${e.hero ? `<td width="40%" valign="top" style="padding:0"><img src="${esc(abs(site, e.hero))}" width="220" alt="" style="display:block;width:100%;max-width:100%;height:auto;border:0"></td>` : ''}
      <td valign="middle" style="padding:20px">
        ${mono('Dropping soon', C.hazard)}
        <div style="padding-top:8px;font-family:${DISPLAY};font-size:20px;line-height:1.05;text-transform:uppercase;color:${C.bone}">${esc(e.name)}</div>
        ${e.tagline ? `<div style="padding-top:6px;font-family:${BODY};font-size:14px;color:${C.smoke}">${esc(e.tagline)}</div>` : ''}
        <div style="padding-top:12px">${mono(`Drops ${esc(when(e.dropsAt))}`, C.bone)}</div>
      </td></tr></table>`, C.ink, '8px 24px');
}

function subjectFor(issue) {
  const [d] = issue.drops, [s] = issue.sales, [e] = issue.soon, [l] = issue.lastCall;
  if (d) return `New drop: ${d.era.name} is live`;
  if (s) return `−${s.percent}% off ${eraNames(issue, s.eras)}, for a limited time`;
  if (e) return `Dropping soon: ${e.name}`;
  return `Last call: −${l.percent}% ends ${when(l.endsAt)}`;
}

function preheader(issue) {
  const bits = [
    ...issue.drops.map(d => `${d.era.name} is live`),
    ...issue.sales.map(s => `${s.percent}% off`),
    ...issue.soon.map(e => `${e.name} drops ${when(e.dropsAt)}`),
    ...issue.lastCall.map(s => `sale ends ${when(s.endsAt)}`),
  ];
  return bits.join(' · ');
}

export function newsletterEmail(issue, { site, now, address }) {
  const body = [
    ...issue.drops.map(d => dropSection(d, site)),
    ...issue.sales.map(s => saleSection(s, issue, site)),
    ...(issue.soon.length ? [block(mono('On the radar', C.smoke), C.ink, '24px 24px 4px'), ...issue.soon.map(e => soonSection(e, site))] : []),
    ...issue.lastCall.map(s => saleSection(s, issue, site, true)),
  ].join('');
  const date = new Date(now).toLocaleDateString('en-US', { timeZone: 'America/Jamaica', month: 'long', day: 'numeric', year: 'numeric' });
  return {
    subject: subjectFor(issue),
    html: shell({
      title: "what's new",
      kicker: 'What&rsquo;s new',
      preview: preheader(issue),
      site,
      body: `${block(mono(`Issue &middot; ${esc(date)}`), C.ink, '18px 24px 0')}${body}<tr><td style="height:24px;line-height:24px">&nbsp;</td></tr>`,
      footerNote: `You're getting this because you joined the Evincus list. <a href="${UNSUB}" style="color:${C.bone}">Unsubscribe</a> any time.${address ? `<br>${esc(address)}` : ''}`,
    }),
  };
}

export function confirmEmail(link, site) {
  return {
    subject: 'Confirm you want Evincus drop alerts',
    html: shell({
      title: 'one more step',
      kicker: 'Confirm',
      preview: 'Tap to confirm and get drops, sales and early access first.',
      site,
      body: block(`
        ${chip('Confirm your email')}
        <p style="margin:18px 0 22px;font-family:${BODY};font-size:16px;line-height:1.55;color:${C.bone}">Tap below to get the next warning first: new drops, sales and early access. One email a day at most, only when something's new.</p>
        ${button(link, 'Confirm')}
        <p style="margin:22px 0 0;font-family:${BODY};font-size:13px;line-height:1.55;color:${C.smoke}">Didn't sign up? Ignore this email and you won't hear from us.</p>`),
      footerNote: 'Sent because someone entered this address on the Evincus site.',
    }),
  };
}
