import { readFile, stat } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import manifest from '../assets/js/image-manifest.js';

let failures = 0;
const limits = { 'assets/js/image-manifest.js': 40000, 'assets/css/index.css': 20000, 'index.html': 12000 };
for (const [file, budget] of Object.entries(limits)) {
  const gzipBytes = gzipSync(await readFile(new URL(`../${file}`, import.meta.url))).length;
  console.log(JSON.stringify({ file, gzipBytes, budget }));
  if (gzipBytes > budget) failures++;
}
for (const [original, image] of Object.entries(manifest)) {
  for (const variant of image.variants) {
    const { size } = await stat(new URL(`../${variant.src}`, import.meta.url));
    if (size > 250 * 1024) { console.error(`Responsive photo exceeds 250 KiB: ${original}`); failures++; }
  }
}
process.exitCode = failures ? 1 : 0;
