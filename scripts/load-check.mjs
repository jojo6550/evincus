import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { isolatedServer } from './lib/local-server.mjs';

const server = await isolatedServer();
try {
  const list = await (await fetch(server.url + '/api/eras')).json();
  let product;
  for (const era of list.eras.filter(e => e.status === 'live')) {
    const detail = await (await fetch(server.url + '/api/eras/' + era.slug)).json();
    product ??= detail.products.find(p => p.buyable && !p.soldOut && !p.soldOutVariants.length);
  }
  assert.ok(product, 'A buyable product is needed for the isolated checkout check');
  const item = { id: product.id, color: product.colors[0].name, size: product.sizes[0], qty: 1 };
  const requests = [
    ...Array.from({ length: 60 }, () => ({ path: '/', method: 'GET' })),
    ...Array.from({ length: 30 }, () => ({ path: '/api/eras', method: 'GET' })),
    ...Array.from({ length: 20 }, () => ({ path: '/api/bag/quote', method: 'POST', body: { items: [item] } })),
  ];
  const latencies = [], failures = [];
  const started = performance.now();
  await Promise.all(Array.from({ length: 10 }, async () => {
    while (requests.length) {
      const { path, method, body } = requests.shift();
      const before = performance.now();
      const res = await fetch(server.url + path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10000) });
      await res.arrayBuffer();
      latencies.push(performance.now() - before);
      if (!res.ok) failures.push({ path, status: res.status });
    }
  }));
  const order = { checkoutToken: crypto.randomUUID(), items: [item], customer: { name: 'Load Test', email: 'isolated@example.com', phone: '5551234567' }, fulfillment: { type: 'pickup', locationId: 'trendy-hats' }, expectedTotalCents: product.priceCents };
  const orders = await Promise.all(Array.from({ length: 5 }, async () => {
    const res = await fetch(server.url + '/api/orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(order), signal: AbortSignal.timeout(10000) });
    assert.equal(res.status, 201); return res.json();
  }));
  assert.equal(new Set(orders.map(o => o.id)).size, 1);
  latencies.sort((a, b) => a - b);
  const p95Ms = Math.round(latencies[Math.ceil(latencies.length * 0.95) - 1]);
  const report = { testedAt: new Date().toISOString(), environment: 'isolated local Node server; email disabled; temporary KV', requests: latencies.length, concurrency: 10, failures, p95Ms, maxMs: Math.round(latencies.at(-1)), durationMs: Math.round(performance.now() - started), duplicateSubmissions: 5, uniqueOrders: 1, ...await server.metrics() };
  delete report.type;
  console.log(JSON.stringify(report, null, 2));
  assert.equal(failures.length, 0);
  assert.ok(p95Ms < 1500, `p95 ${p95Ms} ms exceeds the local 1500 ms regression budget`);
} finally { await server.stop(); }
