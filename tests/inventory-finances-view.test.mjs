import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderFinances, financesHtml } from '../assets/js/inventory-finances.js';

const read = f => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
// The mockup's October.
const OCT = {
  empty: false, revenueCents: 481240, refundsCents: 8452, netCents: 472788, gctOwedCents: 58776, feesCents: 23244, cogsCents: 140200,
  costMissing: 0, profitCents: 250568, marginBps: 5300,
  bestSellers: [{ id: 'disaster-zone-tee', name: 'Disaster <Zone> Tee', units: 24, revenueCents: 103800, profitCents: 56100 }],
  refunds: [{ orderId: 'EV-5aa1e9f0', at: '2026-10-20T16:00:00.000Z', reason: 'Wrong <size>', amountCents: 4226 }],
  months: [{ month: '2026-09', revenueCents: 402000, gctOwedCents: 49200, profitCents: 209600, orders: 50 }, { month: '2026-10', revenueCents: 481240, gctOwedCents: 58776, profitCents: 250568, orders: 61 }],
};
const root = () => ({ innerHTML: '' });

test('no payments yet: one line, no tiles', () => {
  const el = root();
  renderFinances(el, { ...OCT, empty: true }, { owner: true });
  assert.equal(el.innerHTML.replace(/<[^>]+>/g, '').trim(), 'No payments collected yet. Order value is in Stats.');
  assert.ok(!el.innerHTML.includes('tile'));
});

test('tiles show the mockup numbers, and customer text is escaped', () => {
  const html = financesHtml(OCT, { from: '2026-10-01', to: '2026-10-31' });
  for (const s of ['$4,812.40', '−$84.52', '$4,727.88', '−$587.76', '−$232.44', '−$1,402.00', '$2,505.68', '53%', 'Disaster &lt;Zone&gt; Tee', 'Wrong &lt;size&gt;', 'EV-5aa1e9f0',
    'href="/api/inventory/finances.csv?from=2026-10-01&amp;to=2026-10-31"', 'Download CSV']) assert.ok(html.includes(s), s);
  assert.ok(!html.includes('<size>') && !html.includes('<Zone>'));
  assert.ok(!html.includes('cost missing'));
  assert.match(financesHtml({ ...OCT, costMissing: 3 }, {}), /cost missing on 3 items/);
  assert.match(financesHtml({ ...OCT, costMissing: 1 }, {}), /cost missing on 1 item\b/);
});

test('staff never get the tab or its numbers', () => {
  const el = root();
  renderFinances(el, OCT, { owner: false });
  assert.equal(el.innerHTML, '');
  assert.match(read('assets/js/inventory.js'), /\{ name: 'finances', label: 'Finances', ownerOnly: true \}/);
});

test('one chart implementation, no inline code in the page', () => {
  const src = read('assets/js/inventory-finances.js');
  assert.match(src, /from '\.\/inventory-chart\.js'/);
  assert.ok(!/<svg|<path|<rect/.test(src), 'draws no chart of its own');
  const html = read('inventory.html');
  assert.ok(!/style=/.test(html));
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/.test(html), 'no inline script');
  assert.match(html, /src="\/assets\/js\/inventory-finances\.js"/);
});
