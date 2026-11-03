import manifest from './image-manifest.js';

// Catalog photos: media/ plus MEDIA_NAME from server/lib/media.js.
const MEDIA = /^\/?media\/[0-9a-f]{24}-[0-9]{3,4}\.(?:webp|jpg)$/;

const esc = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export function safeImage(path) {
  const text = String(path ?? '');
  if (MEDIA.test(text)) return text;
  return /^(?:\/?assets\/|\/?data\/eras\/)[a-zA-Z0-9/_ .-]+\.(?:jpg|jpeg|png|webp|avif)$/.test(text) && !text.includes('..') ? text : '';
}
// Catalog photo sizes arrive with the API response (its `media` map), not in the bundled manifest.
export function registerImages(map) {
  Object.assign(manifest, map);
}
export function imageAttrs(path, sizes = '(max-width: 760px) 46vw, 24vw') {
  const safe = safeImage(path);
  const image = manifest[safe.replace(/^\//, '')];
  if (!image) return `src="${esc(safe)}" decoding="async"`;
  return `src="/${esc(image.variants.at(-1).src)}" srcset="${esc(image.variants.map(v => `/${v.src} ${v.width}w`).join(', '))}" sizes="${esc(sizes)}" width="${esc(image.width)}" height="${esc(image.height)}" decoding="async"`;
}
// Lazy photos ease in as they arrive (index.css holds each at the start of its fade until it's marked .is-in).
// Anything already loaded when this runs goes straight through, and a broken image still shows its alt text.
export function initImageFade() {
  const arrive = e => { if (e.target instanceof HTMLImageElement) e.target.classList.add('is-in'); };
  document.addEventListener('load', arrive, true);
  document.addEventListener('error', arrive, true);
  for (const img of document.images) if (img.complete) img.classList.add('is-in');
  document.documentElement.classList.add('img-fade');
}
export function updateImage(element, path, sizes) {
  const template = document.createElement('template');
  template.innerHTML = `<img ${imageAttrs(path, sizes)}>`;
  for (const name of ['srcset', 'sizes', 'width', 'height']) element.removeAttribute(name);
  for (const attr of template.content.firstChild.attributes) element.setAttribute(attr.name, attr.value);
}
