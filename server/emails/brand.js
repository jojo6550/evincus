// The branded email frame and parts, styled like the site: near-black page, bone tape, hazard red, the inverted logo.
// Email clients ignore stylesheets, so styles are inline and layout is tables. Fonts fall back to system faces.
// One fluid 600px column: phones get it full width, so nothing here needs a media query.
import { esc } from './html.js';

export const C = { ink: '#0d0c0f', ash: '#17151a', char: '#24212a', bone: '#f3efe8', smoke: '#948e9c', hazard: '#e8323c' };
export const DISPLAY = "'Archivo Black','Arial Black',Impact,Arial,sans-serif";
export const BODY = "Archivo,Helvetica,Arial,sans-serif";
export const MONO = "'IBM Plex Mono',Consolas,'Courier New',monospace";
export const MARKER = "'Permanent Marker','Brush Script MT','Segoe Script',cursive";
const DEFAULT_SITE = 'https://evincus.shop';

export const abs = (site, path) => (/^https?:\/\//.test(path) ? path : `${site}/${String(path).replace(/^\/+/, '')}`);

export const mono = (text, color = C.smoke, size = 11) =>
  `<span style="font-family:${MONO};font-size:${size}px;letter-spacing:2px;text-transform:uppercase;color:${color}">${text}</span>`;

export const tape = (text, bg = C.bone, fg = C.ink) => `<tr><td style="background:${bg};border-top:2px solid ${C.ink};border-bottom:2px solid ${C.ink};padding:9px 12px;text-align:center;font-family:${DISPLAY};font-size:12px;letter-spacing:3px;text-transform:uppercase;color:${fg}">${text}</td></tr>`;

export const button = (href, label, bg = C.bone, fg = C.ink) =>
  `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td style="background:${bg};border:2px solid ${bg}"><a href="${esc(href)}" style="display:inline-block;padding:15px 26px;font-family:${DISPLAY};font-size:13px;letter-spacing:2px;text-transform:uppercase;color:${fg};text-decoration:none">${label} &rarr;</a></td></tr></table>`;

export const chip = (text, bg = C.hazard, fg = C.ink) =>
  `<span style="display:inline-block;background:${bg};color:${fg};padding:5px 10px;font-family:${MONO};font-size:11px;letter-spacing:2px;text-transform:uppercase">${text}</span>`;

export const block = (inner, bg = C.ink, pad = '28px 24px') => `<tr><td style="background:${bg};padding:${pad}">${inner}</td></tr>`;

const footLink = (href, label) => `<a href="${esc(href)}" style="color:${C.bone};text-decoration:none;font-family:${MONO};font-size:11px;letter-spacing:2px;text-transform:uppercase">${label}</a>`;

// kicker: the top tape's text. title: the marker line under the logo. footerNote: trusted HTML.
export const shell = ({ title, kicker, preview, body, site = DEFAULT_SITE, footerNote }) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><meta name="supported-color-schemes" content="dark"><title>${esc(title)}</title></head>
<body style="margin:0;padding:0;background:${C.ink};color:${C.bone}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(preview)}&#8199;&#65279;&#847;&#8199;&#65279;&#847;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.ink}"><tr><td align="center" style="padding:0">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;table-layout:fixed;background:${C.ink}">
  ${tape(`${kicker} &nbsp;&#9650;&nbsp; Evincus`)}
  <tr><td style="padding:28px 24px 24px;border-bottom:1px solid ${C.char}">
    <a href="${esc(site)}" style="text-decoration:none">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
        <td width="72" valign="middle" style="padding:0"><img src="${esc(abs(site, '/assets/img/logo-email.png?v=ccbf3946cf1a'))}" width="72" height="64" alt="Evincus" style="display:block;width:72px;height:64px;border:0"></td>
        <td valign="middle" style="padding:0 0 0 12px">
          <div style="font-family:${DISPLAY};font-size:32px;line-height:.9;letter-spacing:4px;color:${C.bone}">EVINCUS</div>
          <div style="font-family:${DISPLAY};font-size:32px;line-height:.9;letter-spacing:4px;color:${C.ink};-webkit-text-stroke:1px ${C.smoke}">EVINCUS</div>
        </td>
      </tr></table>
    </a>
    <div style="padding-top:12px;font-family:${MARKER};font-size:30px;color:${C.hazard};line-height:1">${esc(title)}</div>
  </td></tr>
  ${body}
  ${tape('//// &nbsp;Made for chaos&nbsp; ////', C.hazard)}
  <tr><td style="padding:28px 24px 34px;background:${C.ash}">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
      <td width="40" valign="middle" style="padding:0"><img src="${esc(abs(site, '/assets/img/logo-email.png?v=ccbf3946cf1a'))}" width="40" height="36" alt="" style="display:block;width:40px;height:36px;border:0"></td>
      <td valign="middle" style="padding:0 0 0 10px">
        <div style="font-family:${DISPLAY};font-size:15px;letter-spacing:4px;color:${C.bone}">EVINCUS</div>
        <div style="padding-top:2px;font-family:${MARKER};font-size:16px;color:${C.hazard}">peace in chaos</div>
      </td>
    </tr></table>
    <div style="padding:16px 0;line-height:2">
      ${footLink(`${site}/index.html#shop`, 'Shop')}&nbsp;&nbsp;&middot;&nbsp;&nbsp;${footLink(`${site}/eras.html`, 'Eras')}&nbsp;&nbsp;&middot;&nbsp;&nbsp;${footLink('https://www.instagram.com/evincus.sw/', 'Instagram')}&nbsp;&nbsp;&middot;&nbsp;&nbsp;${footLink('https://www.tiktok.com/@_evincus_', 'TikTok')}
    </div>
    <p style="margin:0;font-family:${BODY};font-size:12px;line-height:1.6;color:${C.smoke}">${footerNote}</p>
  </td></tr>
</table>
</td></tr></table>
</body></html>`;
