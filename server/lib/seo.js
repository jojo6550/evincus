// Search and social metadata built from the catalog: robots.txt, sitemap.xml and the <head> of /products/<id>.
// Canonical URLs always name the production site, so staging copies never compete with it in search.
import { publicView } from '../../data/catalog.js';

// www is the live host: Render answers the bare domain with a 301 to it.
export const SITE = 'https://www.evincus.shop';
const HOST = new URL(SITE).hostname;

// Crawling is allowed only on the real domain, so onrender.com and local copies stay out of search. The Host header
// decides, not ENVIRONMENT, so a missing env var can't hide the live site.
export function crawlable(host) {
  const name = String(host ?? '').toLowerCase().replace(/:\d+$/, '');
  return name === HOST || name === HOST.replace(/^www\./, '');
}
export const BRAND = 'Evincus Streetwear';

const esc = t => String(t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// JSON-LD is data, not script, but a "</script>" inside a value would still end the tag.
const ldJson = obj => `<script type="application/ld+json">${JSON.stringify(obj).replace(/</g, '\\u003c')}</script>`;
const list = words => words.length < 2 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;

export const productImages = p => [...new Set([...(p.images ?? []), ...p.colors.flatMap(c => c.images ?? [])])];

export const robotsTxt = allowed => allowed
  ? `User-agent: *\nAllow: /\nDisallow: /api/\n\nSitemap: ${SITE}/sitemap.xml\n`
  : 'User-agent: *\nDisallow: /\n';

export function sitemapXml(data, now) {
  const { products } = publicView(data, now);
  const urls = [
    { loc: `${SITE}/`, priority: '1.0' },
    ...products.map(p => ({ loc: `${SITE}/products/${p.id}`, priority: '0.8', images: productImages(p) })),
    { loc: `${SITE}/eras.html`, priority: '0.6' },
    { loc: `${SITE}/policies.html`, priority: '0.3' },
  ];
  const entry = u => `  <url><loc>${esc(u.loc)}</loc><priority>${u.priority}</priority>${(u.images ?? []).map(src => `<image:image><image:loc>${esc(`${SITE}/${src}`)}</image:loc></image:image>`).join('')}</url>`;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">\n${urls.map(entry).join('\n')}\n</urlset>\n`;
}

export function productDescription(p, era) {
  const colors = p.colors.map(c => c.name);
  const sizes = p.sizes.length > 1 ? `Sizes ${p.sizes[0]} to ${p.sizes.at(-1)}` : `Size ${p.sizes[0]}`;
  return `${p.name} from the ${era.name} collection by ${BRAND}. ${p.fabric ? `${p.fabric}. ` : ''}In ${list(colors)}. ${sizes}. Ships worldwide.`;
}

const availability = (p, era) => `https://schema.org/${era.status === 'archived' ? 'Discontinued' : p.soldOut ? 'OutOfStock' : 'InStock'}`;

// Replaces index.html's default <!-- seo --> block. `p` comes from publicView with sales applied.
export function productHead(p, era) {
  const url = `${SITE}/products/${p.id}`;
  const images = productImages(p).map(src => `${SITE}/${src}`);
  const title = `${p.name} | ${BRAND}`;
  const description = productDescription(p, era);
  const price = (p.priceCents / 100).toFixed(2);
  return [
    `<title>${esc(title)}</title>`,
    `<meta name="description" content="${esc(description)}">`,
    `<link rel="canonical" href="${url}">`,
    `<meta property="og:type" content="product">`,
    `<meta property="og:site_name" content="${BRAND}">`,
    `<meta property="og:title" content="${esc(title)}">`,
    `<meta property="og:description" content="${esc(description)}">`,
    `<meta property="og:url" content="${url}">`,
    ...(images[0] ? [`<meta property="og:image" content="${esc(images[0])}">`, `<meta property="og:image:alt" content="${esc(p.name)}">`] : []),
    `<meta property="product:brand" content="${BRAND}">`,
    `<meta property="product:price:amount" content="${price}">`,
    `<meta property="product:price:currency" content="USD">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    ldJson({
      '@context': 'https://schema.org',
      '@type': 'Product',
      '@id': `${url}#product`,
      name: p.name,
      description,
      sku: p.id,
      url,
      image: images,
      category: p.category,
      color: p.colors.map(c => c.name).join(', '),
      size: p.sizes.join(', '),
      ...(p.fabric && { material: p.fabric }),
      brand: { '@type': 'Brand', name: BRAND },
      offers: {
        '@type': 'Offer',
        url,
        priceCurrency: 'USD',
        price,
        ...(p.sale?.endsAt && { priceValidUntil: p.sale.endsAt.slice(0, 10) }),
        availability: availability(p, era),
        itemCondition: 'https://schema.org/NewCondition',
        seller: { '@type': 'Organization', name: BRAND, url: `${SITE}/` },
      },
    }),
    ldJson({
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Shop', item: `${SITE}/` },
        { '@type': 'ListItem', position: 2, name: `${era.name} collection`, item: `${SITE}/eras.html` },
        { '@type': 'ListItem', position: 3, name: p.name, item: url },
      ],
    }),
  ].join('\n');
}
