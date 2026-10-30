// Pure: per-day sales in, SVG markup out. No DOM, so Node tests import it. Colours and the hover/focus look live in
// inventory.css; the series hue is the one data colour (#3987e5).
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const W = 343, H = 126, LEFT = 30, TOP = 10, BASE = 110, GAP = 2, RADIUS = 4;

const esc = s => String(s).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const n = v => +v.toFixed(3);
const plural = (k, word) => `${k} ${word}${k === 1 ? '' : 's'}`;
export const fmtDay = d => `${+d.slice(8, 10)} ${MONTHS[+d.slice(5, 7) - 1]}`;
export const dollars = cents => `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const describe = p => `${fmtDay(p.day)}: ${dollars(p.cents)}, ${plural(p.orders, 'order')}`;

// The smallest 1/2/5 x 10^k dollar amount that holds the tallest bar, in cents.
function niceMax(cents) {
  const d = Math.max(cents, 100) / 100, pow = 10 ** Math.floor(Math.log10(d));
  return [1, 2, 5, 10].map(m => m * pow).find(v => v >= d) * 100;
}

// One bar per day, 4px rounded tops on the baseline, 2px apart, one value axis. Each day is a focusable slot (a full-height
// hit area), so hover and keyboard focus both reach days with no sales.
export function barChart(data, { title = 'Sales per day' } = {}) {
  const max = niceMax(Math.max(0, ...data.map(p => p.cents)));
  const count = Math.max(data.length, 1);
  const bw = (W - LEFT - 4 - GAP * (count - 1)) / count;
  const scale = (BASE - TOP) / max;
  const peak = data.reduce((a, p) => (p.cents > (a?.cents ?? -1) ? p : a), null);
  const label = data.length ? `${title}, ${fmtDay(data[0].day)} to ${fmtDay(data.at(-1).day)}.${peak?.cents ? ` Highest ${dollars(peak.cents)} on ${fmtDay(peak.day)}.` : ' No sales.'}` : `${title}. No days.`;
  const out = [`<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}">`];
  for (const [f, y] of [[1, TOP], [.5, (TOP + BASE) / 2]]) out.push(`<line class="gl" x1="${LEFT}" x2="${W}" y1="${y}" y2="${y}"/><text x="0" y="${y + 3}">$${n(max * f / 100)}</text>`);
  out.push(`<line class="base" x1="${LEFT}" x2="${W}" y1="${BASE}" y2="${BASE}"/><text x="12" y="${BASE + 3}">0</text>`);
  data.forEach((p, i) => {
    const x = LEFT + 4 + i * (bw + GAP), h = p.cents * scale, r = Math.min(RADIUS, bw / 2, h), y = BASE - h;
    const bar = h > 0
      ? `<path class="bar" d="M${n(x)},${BASE}V${n(y + r)}Q${n(x)},${n(y)} ${n(x + r)},${n(y)}H${n(x + bw - r)}Q${n(x + bw)},${n(y)} ${n(x + bw)},${n(y + r)}V${BASE}Z"/>`
      : '';
    out.push(`<g class="slot" tabindex="0" data-i="${i}" aria-label="${esc(describe(p))}"><rect class="hit" x="${n(x - GAP / 2)}" y="${TOP}" width="${n(bw + GAP)}" height="${BASE - TOP}"/>${bar}</g>`);
  });
  if (data.length) out.push(`<text x="${LEFT + 4}" y="${H - 2}">${esc(fmtDay(data[0].day))}</text><text class="end" x="${W}" y="${H - 2}" text-anchor="end">${esc(fmtDay(data.at(-1).day))}</text>`);
  return out.join('') + '</svg>';
}
