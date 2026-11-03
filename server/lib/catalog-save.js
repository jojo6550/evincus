// Product and era saves, era order, validation and product history. Keys, loading and seeding stay in catalog-store.js.
import { variantWidths } from '../../data/photos.js';
import { listAll, stockKey, stockDoc, adjKey } from './stock.js';
import { HttpError } from './http.js';
import { isOpId, readOpEntry, opPut } from './ops.js';
import { REV_KEY, ERA_ORDER_KEY, eraKey, productKey, defaultSku, loadCatalog } from './catalog-store.js';

// Every save is one commit: the record's version check, op:<opId>, and a blind REV_KEY put. A stored op returns
// the record as it is now, with its version, so a retry never pairs an old record with a newer version.
const ROUNDS = 5;
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const isSlug = v => typeof v === 'string' && v.length <= 60 && SLUG.test(v);
const isHex = v => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);
const isText = (v, max) => typeof v === 'string' && v.length <= max;
// Colour and size names go into '<colour>|<size>' keys and cart lines, which take ≤ 100 characters.
const isName = v => typeof v === 'string' && v === v.trim() && v.length >= 1 && v.length <= 100 && !v.includes('|');
const isRef = r => !!r && typeof r === 'object' && /^[0-9a-f]{24}$/.test(r.id) && (r.ext === 'webp' || r.ext === 'jpg')
  && Number.isInteger(r.width) && r.width >= 100 && r.width <= 1440 && Number.isInteger(r.height) && r.height >= 1 && r.height <= 10000
  && Array.isArray(r.widths) && r.widths.every(Number.isInteger) && r.widths.join() === variantWidths(r.width).join();
const isIso = v => v === null || (typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d(\.\d{1,3})?)?(Z|[+-]\d\d:\d\d)$/.test(v) && Number.isFinite(Date.parse(v)));
const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v);
const arr = v => (Array.isArray(v) ? v : []);
const dupes = a => new Set(a).size !== a.length;
const trim = v => (typeof v === 'string' ? v.trim() : v);
const ref = ({ id, width, height, widths, ext }) => ({ id, width, height, widths, ext });
const colorOf = k => k.slice(0, k.indexOf('|'));
const sizeOf = k => k.slice(k.indexOf('|') + 1);
const skusOf = (products, id) => new Set(products.filter(o => o.id !== id).flatMap(o => Object.values(o.skus ?? {})));
const orderOf = (entry, head) => (entry.value ? JSON.parse(entry.value) : head?.eraOrder ?? []);
// A store seeded before ERA_ORDER_KEY keeps its only era order in REV_KEY.eraOrder (loadCatalog's fallback), so a write
// carries it until `ordered`: ERA_ORDER_KEY was read and exists, or this commit writes it.
const revPut = (head, ordered) => ({ key: REV_KEY, value: JSON.stringify({ rev: crypto.randomUUID(), ...(!ordered && head?.eraOrder && { eraOrder: head.eraOrder }) }) });

// Error codes for a product save; [] when it may be saved. `current` is the stored product (null when creating),
// `stock` its stock document, `renames` { old colour: new colour }, `id` the id it is saved under.
export function validateProduct(p, { eras = [], products = [], stock = {}, current = null, renames, id = current?.id } = {}) {
  if (!isObject(p)) return ['product-invalid'];
  const errors = [];
  const check = (bad, code) => { if (bad) errors.push(code); };
  const sizes = arr(p.sizes), colors = arr(p.colors).map(c => (isObject(c) ? c : {})), names = colors.map(c => c.name);
  const photos = [p.images, ...colors.map(c => c.images)].filter(v => v !== undefined);
  check(!isSlug(p.id) || ['new', 'eras'].includes(p.id), 'id-invalid'); // #inventory/new and #inventory/eras are other pages
  check(id !== undefined && p.id !== id, 'id-changed');
  check(!eras.some(e => e.slug === p.era), 'era-unknown');
  check(!['active', 'draft', 'archived'].includes(p.status), 'status-invalid');
  check(!isText(p.name, 120), 'name-invalid');
  check(p.description !== undefined && !isText(p.description, 5000), 'description-invalid');
  check(!isText(p.fabric, 300), 'fabric-invalid');
  check(!isText(p.category, 60), 'category-invalid');
  check(p.priceCents !== null && !(Number.isSafeInteger(p.priceCents) && p.priceCents > 0), 'price-invalid');
  check(!(Number.isSafeInteger(p.costCents) && p.costCents >= 0), 'cost-invalid');
  check(typeof p.continueSelling !== 'boolean', 'continue-selling-invalid');
  check(!(Number.isSafeInteger(p.lowStockAt) && p.lowStockAt >= 0), 'low-stock-invalid');
  check(!Array.isArray(p.sizes) || sizes.length > 30 || !sizes.every(isName), 'size-invalid');
  check(dupes(sizes), 'size-duplicate');
  check(!Array.isArray(p.colors) || colors.length > 30 || !names.every(isName), 'color-invalid');
  check(dupes(names), 'color-duplicate');
  check(!colors.every(c => isHex(c.hex) && (c.ring === undefined || isHex(c.ring))), 'hex-invalid');
  check(!photos.every(v => Array.isArray(v) && v.length <= 30 && v.every(isRef)), 'photo-invalid');
  if (p.status === 'active') {
    check(!p.name?.trim?.(), 'name-required');
    check(p.priceCents === null, 'price-required');
    check(!sizes.length, 'sizes-required');
    check(!colors.length, 'colors-required');
    check(!photos.flatMap(arr).length, 'photo-required');
  }
  const skus = isObject(p.skus) ? colors.flatMap(c => sizes.map(s => p.skus[`${c.name}|${s}`])).filter(s => s !== undefined) : null;
  check(!skus?.every(s => typeof s === 'string' && s === s.trim() && s.length >= 1 && s.length <= 64), 'sku-invalid');
  // shortcut: checked against the cached catalog, so two products saved at once with one new SKU can both land; add per-SKU keys if that bites
  const others = skusOf(products, p.id);
  check(dupes(skus ?? []) || arr(skus).some(s => others.has(s)), 'sku-taken');
  // A rename is only what the client says it is; any other colour missing from the save is a removal.
  const shaped = isObject(renames ?? {}) && Object.values(renames ?? {}).every(v => typeof v === 'string');
  const rn = shaped ? renames ?? {} : {};
  const before = arr(current?.colors).map(c => c.name);
  const after = n => (Object.hasOwn(rn, n) ? rn[n] : n);
  check(!shaped || Object.entries(rn).some(([a, b]) => !before.includes(a) || !names.includes(b) || a === b)
    || dupes(before.map(after).filter(n => names.includes(n))), 'rename-invalid');
  const rows = Object.entries(stock ?? {});
  const held = test => rows.some(([k, v]) => test(k) && (v.onHand > 0 || v.committed > 0));
  check(rows.some(([k, v]) => Object.hasOwn(rn, colorOf(k)) && v.committed > 0), 'color-committed');
  const gone = before.filter(n => !names.includes(after(n)));
  check(held(k => gone.includes(colorOf(k))), 'color-has-stock');
  const goneSizes = arr(current?.sizes).filter(s => !sizes.includes(s));
  check(held(k => goneSizes.includes(sizeOf(k))), 'size-has-stock');
  return errors;
}

// The stored document: known fields only. A variant keeps the SKU of the stock it carries (`source` gives a colour's
// old name: through a rename, or itself if kept; null when new) unless the page sent one; new variants get defaultSku.
function productDoc(p, { current, catalog, source, at }) {
  const variants = p.colors.flatMap(c => p.sizes.map(s => [c.name, s]));
  const taken = skusOf(catalog.products, p.id);
  for (const [c, s] of variants) if (p.skus[`${c}|${s}`] !== undefined) taken.add(p.skus[`${c}|${s}`]);
  const skus = {};
  for (const [c, s] of variants) { // kept SKUs first, so no default takes one a renamed colour carries over
    const prev = source(c) === null ? undefined : current?.skus?.[`${source(c)}|${s}`];
    skus[`${c}|${s}`] = p.skus[`${c}|${s}`] ?? (prev && !taken.has(prev) ? prev : undefined);
    if (skus[`${c}|${s}`]) taken.add(skus[`${c}|${s}`]);
  }
  for (const [c, s] of variants) if (!skus[`${c}|${s}`]) taken.add(skus[`${c}|${s}`] = defaultSku(p.id, c, s, taken));
  const last = Math.max(-1, ...catalog.products.filter(o => o.era === p.era && o.id !== p.id).map(o => o.position ?? -1));
  return {
    id: p.id, era: p.era, status: p.status, name: p.name, ...(p.description !== undefined && { description: p.description }),
    fabric: p.fabric, category: p.category, priceCents: p.priceCents, costCents: p.costCents, sizes: p.sizes,
    colors: p.colors.map(c => ({ name: c.name, hex: c.hex, ...(c.ring !== undefined && { ring: c.ring }), ...(c.images !== undefined && { images: c.images.map(ref) }) })),
    ...(p.images !== undefined && { images: p.images.map(ref) }),
    skus, continueSelling: p.continueSelling, lowStockAt: p.lowStockAt,
    position: current?.era === p.era ? current.position : last + 1,
    createdAt: current ? current.createdAt : at, updatedAt: at,
  };
}

const cents = v => (v == null ? '—' : (v / 100).toFixed(2));
const quoted = v => `"${v ?? ''}"`;
const listed = a => a.join(', ') || '—';
const EDITS = [ // field, label, how a value reads (none: "<label> edited")
  ['name', 'Name', quoted], ['status', 'Status', String], ['era', 'Era', String], ['category', 'Category', String],
  ['fabric', 'Fabric', quoted], ['description', 'Description'], ['priceCents', 'Price', cents], ['costCents', 'Cost', cents],
  ['sizes', 'Sizes', listed], ['continueSelling', 'Keep selling when out of stock', v => (v ? 'on' : 'off')], ['lowStockAt', 'Low stock at', String],
];
// One { field, summary } per changed field, for history.
function edits(a, b) {
  const same = (x, y) => JSON.stringify(x ?? null) === JSON.stringify(y ?? null);
  const out = EDITS.filter(([f]) => !same(a[f], b[f]))
    .map(([field, label, show]) => ({ field, summary: show ? `${label} ${show(a[field])} → ${show(b[field])}` : `${label} edited` }));
  const swatches = p => arr(p.colors).map(({ name, hex, ring }) => [name, hex, ring]);
  const [na, nb] = [a, b].map(p => arr(p.colors).map(c => c.name));
  if (!same(swatches(a), swatches(b))) out.push({ field: 'colors', summary: same(na, nb) ? 'Colour swatches edited' : `Colours ${listed(na)} → ${listed(nb)}` });
  const [pa, pb] = [a, b].map(p => [...arr(p.images), ...arr(p.colors).flatMap(c => arr(c.images))].map(r => r.id));
  const added = pb.filter(x => !pa.includes(x)).length, removed = pa.filter(x => !pb.includes(x)).length;
  if (!same(pa, pb)) out.push({ field: 'photos', summary: added || removed ? `Photos: ${added} added, ${removed} removed` : 'Photos: reordered' });
  const skus = Object.keys(b.skus).filter(v => Object.hasOwn(a.skus ?? {}, v) && a.skus[v] !== b.skus[v]).length;
  if (skus) out.push({ field: 'skus', summary: `SKUs: ${skus} changed` });
  return out;
}

// The stock document lists exactly the saved variants, since adjustments and checkouts refuse any other: rows move with
// a rename, new variants get zero rows, and removed ones (all zero: validation needs them so) are dropped.
function stockRows(doc, stock, source) {
  return Object.fromEntries(doc.colors.flatMap(c => doc.sizes.map(s => [`${c.name}|${s}`,
    (source(c.name) !== null && stock[`${source(c.name)}|${s}`]) || { onHand: 0, committed: 0 }])));
}
const canon = doc => JSON.stringify(Object.keys(doc).sort().map(k => [k, doc[k]]));

const entryOf = async (env, key) => { const { value, version } = await env.ORDERS.getEntry(key); return { value: JSON.parse(value), version }; };
const readProduct = async (env, id) => { const { value, version } = await entryOf(env, productKey(id)); return { product: value, version }; };
const readEra = async (env, slug) => { const { value, version } = await entryOf(env, eraKey(slug)); return { era: value, version }; };
const invalid = (code, errors) => new HttpError(code, 400, { errors });

// `version` null creates. `renames` maps old colour names to new ones; `id` is the id in the URL.
export async function saveProduct(env, { opId, product, id = product?.id, renames, version, by, now }) {
  if (!isOpId(opId)) throw invalid('invalid-product', ['op-invalid']);
  for (let round = 0; round < ROUNDS; round++) {
    const op = await readOpEntry(env, opId, 'product'); // before validating, so a retry replays whatever changed since
    if (op.result) return { ...await readProduct(env, op.result.id), created: false, replayed: true };
    if (version !== null && typeof version !== 'string') throw invalid('invalid-product', ['version-invalid']);
    const key = productKey(id);
    const [cur, st, head, order, catalog] = await Promise.all([env.ORDERS.getEntry(key), env.ORDERS.getEntry(stockKey(id)),
      env.ORDERS.get(REV_KEY, 'json'), env.ORDERS.getEntry(ERA_ORDER_KEY), loadCatalog(env)]);
    const current = cur.value ? JSON.parse(cur.value) : null;
    if (version === null && current) throw new HttpError('product-exists', 409, { current, version: cur.version });
    if (version !== null && cur.version !== version) throw new HttpError('product-changed', 409, { current, version: cur.version });
    const p = isObject(product) ? {
      ...product, name: trim(product.name), sizes: Array.isArray(product.sizes) ? product.sizes.map(trim) : product.sizes,
      colors: Array.isArray(product.colors) ? product.colors.map(c => (isObject(c) ? { ...c, name: trim(c.name) } : c)) : product.colors,
    } : product;
    const rn = isObject(renames) ? Object.fromEntries(Object.entries(renames).map(([a, b]) => [a, trim(b)])) : renames;
    const stock = JSON.parse(st.value ?? '{}');
    const errors = validateProduct(p, { eras: catalog.eras, products: catalog.products, stock, current, renames: rn, id });
    if (errors.length) throw invalid('invalid-product', errors);
    const at = now.toISOString();
    const moves = rn ?? {};
    const back = new Map(Object.entries(moves).map(([a, b]) => [b, a]));
    const kept = new Set(arr(current?.colors).map(c => c.name).filter(n => !Object.hasOwn(moves, n)));
    const source = name => back.get(name) ?? (kept.has(name) ? name : null);
    const doc = productDoc(p, { current, catalog, source, at });
    const rows = stockRows(doc, stock, source);
    const changes = current ? edits(current, doc) : [{ field: 'created', summary: `Created as ${doc.status}` }];
    const ok = await env.ORDERS.commit({
      checks: [{ key, version: cur.version }, { key: stockKey(id), version: st.version }, op.check],
      puts: [
        { key, value: JSON.stringify(doc) },
        ...(canon(rows) === canon(stock) ? [] : [{ key: stockKey(id), value: stockDoc(rows) }]),
        ...changes.map((ch, i) => ({ key: adjKey(id, at, opId, i), value: JSON.stringify({ reason: 'edit', ...ch, by, at }) })),
        revPut(head, !!order.value),
        opPut(opId, 'product', { id }),
      ],
    });
    if (ok) return { ...await readProduct(env, id), created: !current, replayed: false };
  }
  throw new HttpError('catalog-busy', 409);
}

// Error codes for an era save; [] when it may be saved.
export function validateEra(e) {
  if (!isObject(e)) return ['era-invalid'];
  const errors = [];
  const check = (bad, code) => { if (bad) errors.push(code); };
  check(!isSlug(e.slug) || e.slug === 'new', 'slug-invalid'); // #inventory/eras/new is the page for creating one
  check(!(isText(e.name, 100) && e.name && e.name === e.name.trim()), 'name-invalid');
  check(!isText(e.tagline ?? '', 200), 'tagline-invalid');
  check(!isText(e.story ?? '', 5000), 'story-invalid');
  check(e.hero != null && !isRef(e.hero), 'hero-invalid');
  check(!['draft', 'published', 'archived'].includes(e.state), 'state-invalid');
  check(!isIso(e.dropsAt ?? null), 'drops-at-invalid');
  check(!isIso(e.endsAt ?? null), 'ends-at-invalid');
  if (e.state === 'published') {
    check(!e.tagline?.trim?.(), 'tagline-required');
    check(!e.story?.trim?.(), 'story-required');
    check(e.hero == null, 'hero-required');
  }
  return errors;
}

// `version` null creates the era as the first in the order (checking ERA_ORDER_KEY too).
export async function saveEra(env, { opId, era, slug = era?.slug, version, now }) {
  if (!isOpId(opId)) throw invalid('invalid-era', ['op-invalid']);
  for (let round = 0; round < ROUNDS; round++) {
    const op = await readOpEntry(env, opId, 'era');
    if (op.result) return { ...await readEra(env, op.result.slug), created: false, replayed: true };
    const e = isObject(era) ? { ...era, name: trim(era.name) } : era;
    const errors = validateEra(e);
    if (isObject(e) && e.slug !== slug) errors.push('slug-changed');
    if (version !== null && typeof version !== 'string') errors.push('version-invalid');
    if (errors.length) throw invalid('invalid-era', errors);
    const key = eraKey(slug);
    const [cur, order, head] = await Promise.all([env.ORDERS.getEntry(key), env.ORDERS.getEntry(ERA_ORDER_KEY), env.ORDERS.get(REV_KEY, 'json')]);
    const current = cur.value ? JSON.parse(cur.value) : null;
    if (version === null && current) throw new HttpError('era-exists', 409, { current, version: cur.version });
    if (version !== null && cur.version !== version) throw new HttpError('era-changed', 409, { current, version: cur.version });
    const at = now.toISOString();
    const doc = {
      slug, name: e.name, tagline: e.tagline ?? '', story: e.story ?? '', hero: e.hero ? ref(e.hero) : null,
      dropsAt: e.dropsAt ?? null, endsAt: e.endsAt ?? null, state: e.state, createdAt: current ? current.createdAt : at, updatedAt: at,
    };
    const first = current ? [] : [{ key: ERA_ORDER_KEY, value: JSON.stringify([slug, ...orderOf(order, head).filter(s => s !== slug)]) }];
    const ok = await env.ORDERS.commit({
      checks: [{ key, version: cur.version }, ...(current ? [] : [{ key: ERA_ORDER_KEY, version: order.version }]), op.check],
      puts: [{ key, value: JSON.stringify(doc) }, ...first, revPut(head, !!order.value || !current), opPut(opId, 'era', { slug })],
    });
    if (ok) return { ...await readEra(env, slug), created: !current, replayed: false };
  }
  throw new HttpError('catalog-busy', 409);
}

// -> { order, version }: `version` is ERA_ORDER_KEY's (null for data seeded before it).
export async function readEraOrder(env) {
  const [entry, head] = await Promise.all([env.ORDERS.getEntry(ERA_ORDER_KEY), env.ORDERS.get(REV_KEY, 'json')]);
  return { order: orderOf(entry, head), version: entry.version };
}

export async function setEraOrder(env, { opId, order, version }) {
  if (!isOpId(opId)) throw new HttpError('invalid-era-order', 400);
  for (let round = 0; round < ROUNDS; round++) {
    const op = await readOpEntry(env, opId, 'era-order');
    if (op.result) return { ...await readEraOrder(env), replayed: true };
    const [entry, head] = await Promise.all([env.ORDERS.getEntry(ERA_ORDER_KEY), env.ORDERS.get(REV_KEY, 'json')]);
    const current = orderOf(entry, head);
    if (entry.version !== version) throw new HttpError('era-order-changed', 409, { current, version: entry.version });
    // Every era is in the stored order (creating one puts it there), so a valid order is a reordering of it.
    if (!Array.isArray(order) || !order.every(isSlug) || JSON.stringify([...order].sort()) !== JSON.stringify([...current].sort())) throw new HttpError('invalid-era-order', 400);
    const ok = await env.ORDERS.commit({
      checks: [{ key: ERA_ORDER_KEY, version: entry.version }, op.check],
      puts: [{ key: ERA_ORDER_KEY, value: JSON.stringify(order) }, revPut(head, true), opPut(opId, 'era-order', { order: true })],
    });
    if (ok) return { ...await readEraOrder(env), replayed: false };
  }
  throw new HttpError('catalog-busy', 409);
}

// One product's adj: records (stock movements and edits), newest first. `before` is the previous page's `next`.
// shortcut: lists every adj: key of the product per page; add a reverse cursor to kv list if one product nears ~10k records
export async function productHistory(env, id, { before, limit = 50 } = {}) {
  const keys = (await listAll(env.ORDERS, `adj:${id}:`)).map(k => k.name).filter(k => !before || k < before).sort().reverse();
  const page = keys.slice(0, limit);
  const items = await Promise.all(page.map(async k => ({ id: k, ...await env.ORDERS.get(k, 'json') })));
  return { items, next: keys.length > limit ? page.at(-1) : null };
}
