// "What's new" and confirm-subscription emails, styled like the site: near-black page, bone tape, hazard red.
// Email clients ignore stylesheets, so styles are inline and layout is tables. Fonts fall back to system faces.
import { esc, money } from './html.js';

export const UNSUB = '%%UNSUBSCRIBE_URL%%';

const C = { ink: '#0d0c0f', ash: '#17151a', char: '#24212a', bone: '#f3efe8', smoke: '#948e9c', hazard: '#e8323c' };
const DISPLAY = "'Archivo Black','Arial Black',Impact,Arial,sans-serif";
const BODY = "Archivo,Helvetica,Arial,sans-serif";
const MONO = "'IBM Plex Mono',Consolas,'Courier New',monospace";
const MARKER = "'Permanent Marker','Brush Script MT','Segoe Script',cursive";

const when = iso => new Date(iso).toLocaleString('en-US', { timeZone: 'America/Jamaica', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const abs = (site, path) => (/^https?:\/\//.test(path) ? path : `${site}/${String(path).replace(/^\/+/, '')}`);

const mono = (text, color = C.smoke, size = 11) =>
  `<span style="font-family:${MONO};font-size:${size}px;letter-spacing:2px;text-transform:uppercase;color:${color}">${text}</span>`;

const tape = (text, bg = C.bone, fg = C.ink) => `<tr><td style="background:${bg};border-top:2px solid ${C.ink};border-bottom:2px solid ${C.ink};padding:9px 12px;text-align:center;font-family:${DISPLAY};font-size:12px;letter-spacing:3px;text-transform:uppercase;color:${fg}">${text}</td></tr>`;

const button = (href, label, bg = C.bone, fg = C.ink) =>
  `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td style="background:${bg};border:2px solid ${bg}"><a href="${esc(href)}" style="display:inline-block;padding:15px 26px;font-family:${DISPLAY};font-size:13px;letter-spacing:2px;text-transform:uppercase;color:${fg};text-decoration:none">${label} &rarr;</a></td></tr></table>`;

const chip = (text, bg = C.hazard, fg = C.ink) =>
  `<span style="display:inline-block;background:${bg};color:${fg};padding:5px 10px;font-family:${MONO};font-size:11px;letter-spacing:2px;text-transform:uppercase">${text}</span>`;

const block = (inner, bg = C.ink, pad = '28px 24px') => `<tr><td style="background:${bg};padding:${pad}">${inner}</td></tr>`;

const price = p => p.compareAtCents > p.priceCents
  ? `<span style="color:${C.smoke};text-decoration:line-through">${money(p.compareAtCents)}</span>&nbsp; <span style="color:${C.hazard}">${money(p.priceCents)}</span>`
  : money(p.priceCents);

const firstImage = p => p.colors?.[0]?.images?.[0] ?? p.images?.[0] ?? null;

function productGrid(products, site) {
  const cells = products.slice(0, 6).map(p => {
    const img = firstImage(p);
    return `<td width="50%" valign="top" style="padding:6px">
      <a href="${esc(`${site}/index.html#p-${p.id}`)}" style="text-decoration:none;color:${C.bone}">
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

const shell = ({ title, preview, body, site, footerNote }) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><meta name="supported-color-schemes" content="dark"><title>${esc(title)}</title></head>
<body style="margin:0;padding:0;background:${C.ink};color:${C.bone}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(preview)}&#8199;&#65279;&#847;&#8199;&#65279;&#847;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.ink}"><tr><td align="center" style="padding:0">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;table-layout:fixed;background:${C.ink}">
  ${tape('What&rsquo;s new &nbsp;&#9650;&nbsp; Evincus')}
  <tr><td style="padding:34px 24px 26px;border-bottom:1px solid ${C.char}">
    <a href="${esc(site)}" style="text-decoration:none">
      <div style="font-family:${DISPLAY};font-size:46px;line-height:.9;letter-spacing:6px;color:${C.bone}">EVINCUS</div>
      <div style="font-family:${DISPLAY};font-size:46px;line-height:.9;letter-spacing:6px;color:${C.ink};-webkit-text-stroke:1px ${C.smoke}">EVINCUS</div>
    </a>
    <div style="padding-top:6px;font-family:${MARKER};font-size:30px;color:${C.hazard};line-height:1">${esc(title)}</div>
  </td></tr>
  ${body}
  ${tape('//// &nbsp;Made for chaos&nbsp; ////', C.hazard)}
  <tr><td style="padding:28px 24px 34px;background:${C.ash}">
    <div style="font-family:${DISPLAY};font-size:15px;letter-spacing:4px;color:${C.bone}">EVINCUS</div>
    <div style="padding:14px 0">
      <a href="${esc(`${site}/index.html#shop`)}" style="color:${C.bone};text-decoration:none;font-family:${MONO};font-size:11px;letter-spacing:2px;text-transform:uppercase">Shop</a>&nbsp;&nbsp;&middot;&nbsp;&nbsp;
      <a href="${esc(`${site}/eras.html`)}" style="color:${C.bone};text-decoration:none;font-family:${MONO};font-size:11px;letter-spacing:2px;text-transform:uppercase">Eras</a>&nbsp;&nbsp;&middot;&nbsp;&nbsp;
      <a href="https://www.instagram.com/evincus.sw/" style="color:${C.bone};text-decoration:none;font-family:${MONO};font-size:11px;letter-spacing:2px;text-transform:uppercase">Instagram</a>&nbsp;&nbsp;&middot;&nbsp;&nbsp;
      <a href="https://www.tiktok.com/@_evincus_" style="color:${C.bone};text-decoration:none;font-family:${MONO};font-size:11px;letter-spacing:2px;text-transform:uppercase">TikTok</a>
    </div>
    <p style="margin:0;font-family:${BODY};font-size:12px;line-height:1.6;color:${C.smoke}">${footerNote}</p>
  </td></tr>
</table>
</td></tr></table>
</body></html>`;

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
