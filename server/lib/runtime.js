import { createBrotliCompress, createGzip, constants } from 'node:zlib';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const HTTP_OPTIONS = { requestTimeout: 30000, headersTimeout: 10000, keepAliveTimeout: 5000, maxHeaderSize: 16384 };

// Cancelling an oversized web body must not destroy the socket before its 413
// can be sent. The adapter closes the connection after that response instead.
export function requestBody(req) {
  let cleanup;
  return new ReadableStream({
    start(controller) {
      const onData = chunk => { controller.enqueue(chunk); if (controller.desiredSize <= 0) req.pause(); };
      const onEnd = () => { cleanup(); controller.close(); };
      const onError = err => { cleanup(); controller.error(err); };
      cleanup = () => { req.off('data', onData); req.off('end', onEnd); req.off('error', onError); };
      req.on('data', onData); req.once('end', onEnd); req.once('error', onError);
    },
    pull() { req.resume(); },
    cancel() { cleanup(); req.once('error', () => {}); req.pause(); },
  });
}

export async function sendResponse(req, res, response) {
  res.statusCode = response.status;
  res.setHeaders(response.headers);
  const hasBody = response.body && req.method !== 'HEAD';
  if (req.method !== 'GET' && req.method !== 'HEAD' && !req.readableEnded) res.setHeader('Connection', 'close');
  const type = response.headers.get('content-type') ?? '';
  const compressible = /^(text\/|application\/(json|javascript))/.test(type);
  if (compressible && !response.headers.has('content-encoding')) {
    res.setHeader('Vary', [...new Set([...(response.headers.get('vary') ?? '').split(',').map(s => s.trim()).filter(Boolean), 'Accept-Encoding'])].join(', '));
  }
  const accepts = String(req.headers['accept-encoding'] ?? '').split(',').map(part => {
    const [name, ...parameters] = part.trim().split(';');
    const q = parameters.find(p => p.trim().startsWith('q='));
    return { name, q: q ? Number(q.trim().slice(2)) : 1 };
  }).filter(x => x.q > 0 && x.q <= 1).sort((a, b) => b.q - a.q);
  const encoding = compressible && !response.headers.has('content-encoding') && accepts.find(x => x.name === 'br' || x.name === 'gzip')?.name;
  if (encoding) {
    res.setHeader('Content-Encoding', encoding);
    res.removeHeader('Content-Length');
  }
  if (!hasBody) { res.end(); return; }
  const source = Readable.fromWeb(response.body);
  if (encoding) {
    const compressor = encoding === 'br' ? createBrotliCompress({ params: { [constants.BROTLI_PARAM_QUALITY]: 4 } }) : createGzip();
    await pipeline(source, compressor, res);
  } else await pipeline(source, res);
}
