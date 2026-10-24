import { readFile, stat, realpath } from 'node:fs/promises';
import { resolve, relative, sep } from 'node:path';

// One bounded cache shared by requests, invalidated by file metadata. Metadata
// also lets conditional requests and HEAD finish without reading file contents.
export function fileAccess(root, { maxBytes = 16 * 1024 * 1024 } = {}) {
  const cache = new Map();
  let bytes = 0;
  async function metadata(path) {
    const canonicalRoot = await realpath(root);
    const expected = resolve(canonicalRoot, path);
    const absolute = await realpath(expected);
    if (!absolute.startsWith(canonicalRoot + sep) || relative(expected, absolute) !== '') throw Object.assign(new Error('Public files must not be symlinks'), { code: 'EACCES' });
    const info = await stat(absolute);
    if (!info.isFile()) throw Object.assign(new Error('Not a file'), { code: 'EISDIR' });
    return { absolute, size: info.size, modified: info.mtime.toUTCString(), etag: `W/"${info.size.toString(16)}-${info.mtimeMs.toString(16)}"` };
  }
  async function read(path, info) {
    info ??= await metadata(path);
    const hit = cache.get(path);
    if (hit?.etag === info.etag) { cache.delete(path); cache.set(path, hit); return hit.body; }
    if (hit) { bytes -= hit.body.length; cache.delete(path); }
    const body = await readFile(info.absolute);
    if (body.length <= maxBytes) {
      while (bytes + body.length > maxBytes) {
        const oldest = cache.keys().next().value;
        bytes -= cache.get(oldest).body.length;
        cache.delete(oldest);
      }
      cache.set(path, { etag: info.etag, body }); bytes += body.length;
    }
    return body;
  }
  return { readFile: read, statFile: metadata };
}
