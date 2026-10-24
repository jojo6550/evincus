import { isIP } from 'node:net';

const normalize = value => {
  if (typeof value !== 'string') return null;
  const ip = value.trim().toLowerCase().replace(/^::ffff:(?=\d+\.)/, '');
  if (!isIP(ip)) return null;
  return isIP(ip) === 6 ? new URL(`http://[${ip}]/`).hostname.slice(1, -1) : ip;
};

// Render explicitly sets the FIRST XFF entry to the client address:
// https://feedback.render.com/features/p/send-the-correct-x-forwarded-for
// Only enable this adapter on Render, whose public ingress supplies that header.
// Local/direct connections never trust caller-supplied forwarding headers.
export function clientIp(req, env) {
  if (env.RENDER === 'true') {
    const forwarded = req.headers['x-forwarded-for'];
    const ip = normalize(typeof forwarded === 'string' ? forwarded.split(',')[0] : null);
    if (ip) return ip;
  }
  return normalize(req.socket.remoteAddress) ?? 'unknown';
}
