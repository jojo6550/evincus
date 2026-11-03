// Pure: per-day sales in, SVG markup out. No DOM, so Node tests import it. Colours and the hover/focus look live in
// inventory.css; the series hue is the one data colour (#3987e5).
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const W = 343, H = 126, LEFT = 44, TOP = 10, BASE = 110, GAP = 2, RADIUS = 4;
const MAX_DAILY = 62; // longer ranges are drawn a week to a bar: at most 53 tab stops over 366 days

const esc = s => String(s).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const n = v => +v.toFixed(3);
const plural = (k, word) => `${k} ${word}${k === 1 ? '' : 's'}`;
export const fmtDay = d => `${+d.slice(8, 10)} ${MONTHS[+d.slice(5, 7) - 1]}`;
export const dollars = (cents, whole = false) => `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: whole ? 0 : 2 })}`;
export const describe = p => `${p.label}: ${dollars(p.cents)}, ${plural(p.orders, 'order')}`;

// The points the chart and its table show: one per day up to 62 days, else one per Monday-start week
// ("Week of 6 Oct"; the first and last may be partial). Days are Jamaica days as 'YYYY-MM-DD'.
export function bucketed(data) {
  if (data.length <= MAX_DAILY) return data.map(p => ({ ...p, label: fmtDay(p.day) }));
  const out = [];
  for (const p of data) {
    const back = (new Date(`${p.day}T00:00:00Z`).getUTCDay() + 6) % 7; // days since Monday
    const start = new Date(Date.parse(`${p.day}T00:00:00Z`) - back * 86400000).toISOString().slice(0, 10);
    const last = out.at(-1);
    if (last?.start === start) { last.cents += p.cents; last.orders += p.orders; }
    else out.push({ start, day: p.day, label: `Week of ${fmtDay(start)}`, cents: p.cents, orders: p.orders });
  }
  return out;
}

// The smallest 1/2/5 x 10^k dollar amount that holds the tallest bar, in cents.
function niceMax(cents) {
  const d = Math.max(cents, 100) / 100, pow = 10 ** Math.floor(Math.log10(d));
  return [1, 2, 5, 10].map(m => m * pow).find(v => v >= d) * 100;
}

// One bar per day, 4px rounded tops on the baseline, 2px apart, one value axis. Each day is a focusable slot (a full-height
// hit area), so hover and keyboard focus both reach days with no sales.
export function barChart(days, { title = 'Sales per day' } = {}) {
  const data = bucketed(days);
  const max = niceMax(Math.max(0, ...data.map(p => p.cents)));
  const count = Math.max(data.length, 1);
  const bw = (W - LEFT - 4 - GAP * (count - 1)) / count;
  const scale = (BASE - TOP) / max;
  const peak = data.reduce((a, p) => (p.cents > (a?.cents ?? -1) ? p : a), null);
  const label = data.length ? `${title}, ${fmtDay(days[0].day)} to ${fmtDay(days.at(-1).day)}.${peak?.cents ? ` Highest ${dollars(peak.cents)}: ${peak.label}.` : ' No sales.'}` : `${title}. No days.`;
  const out = [`<svg viewBox="0 0 ${W} ${H}" role="group"><title>${esc(label)}</title>`];
  for (const [f, y] of [[1, TOP], [.5, (TOP + BASE) / 2]]) out.push(`<line class="gl" x1="${LEFT}" x2="${W}" y1="${y}" y2="${y}"/><text x="${LEFT - 6}" y="${y + 3}" text-anchor="end">${dollars(max * f, max * f % 100 === 0)}</text>`);
  out.push(`<line class="base" x1="${LEFT}" x2="${W}" y1="${BASE}" y2="${BASE}"/><text x="${LEFT - 6}" y="${BASE + 3}" text-anchor="end">$0</text>`);
  data.forEach((p, i) => {
    const x = LEFT + 4 + i * (bw + GAP), h = p.cents * scale, r = Math.min(RADIUS, bw / 2, h), y = BASE - h;
    const bar = h > 0
      ? `<path class="bar" d="M${n(x)},${BASE}V${n(y + r)}Q${n(x)},${n(y)} ${n(x + r)},${n(y)}H${n(x + bw - r)}Q${n(x + bw)},${n(y)} ${n(x + bw)},${n(y + r)}V${BASE}Z"/>`
      : '';
    out.push(`<g class="slot" role="img" tabindex="0" data-i="${i}" aria-label="${esc(describe(p))}"><rect class="hit" x="${n(x - GAP / 2)}" y="${TOP}" width="${n(bw + GAP)}" height="${BASE - TOP}"/>${bar}</g>`);
  });
  if (days.length) out.push(`<text x="${LEFT + 4}" y="${H - 2}">${esc(fmtDay(days[0].day))}</text><text class="end" x="${W}" y="${H - 2}" text-anchor="end">${esc(fmtDay(days.at(-1).day))}</text>`);
  return out.join('') + '</svg>';
}
