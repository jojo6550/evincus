import manifest from './image-manifest.js';

const esc = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export function safeImage(path) {
  const text = String(path ?? '');
  return /^(?:\/?assets\/|\/?data\/eras\/)[a-zA-Z0-9/_ .-]+\.(?:jpg|jpeg|png|webp|avif)$/.test(text) && !text.includes('..') ? text : '';
}
export function imageAttrs(path, sizes = '(max-width: 760px) 46vw, 24vw') {
  const safe = safeImage(path);
  const image = manifest[safe.replace(/^\//, '')];
  if (!image) return `src="${esc(safe)}" decoding="async"`;
  return `src="/${image.variants.at(-1).src}" srcset="${image.variants.map(v => `/${v.src} ${v.width}w`).join(', ')}" sizes="${esc(sizes)}" width="${image.width}" height="${image.height}" decoding="async"`;
}
export function updateImage(element, path, sizes) {
  const template = document.createElement('template');
  template.innerHTML = `<img ${imageAttrs(path, sizes)}>`;
  for (const name of ['srcset', 'sizes', 'width', 'height']) element.removeAttribute(name);
  for (const attr of template.content.firstChild.attributes) element.setAttribute(attr.name, attr.value);
}
