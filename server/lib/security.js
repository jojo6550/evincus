// No third-party subresources in the no-payment storefront: fonts are self-hosted
// and inline styles support the existing UI.
export const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'",
  "font-src 'self'", "img-src 'self' data:",
  "connect-src 'self'", "object-src 'none'", "base-uri 'none'",
  "form-action 'self'", "frame-ancestors 'none'",
].join('; ');

export function secureResponse(response, env = {}) {
  const res = new Response(response.body, response);
  res.headers.set('X-Content-Type-Options', 'nosniff');
  res.headers.set('X-Frame-Options', 'DENY');
  res.headers.set('Referrer-Policy', 'no-referrer');
  res.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  // Report-only supports a staged production rollout; switch after browser QA.
  res.headers.set(env.CSP_MODE === 'enforce' ? 'Content-Security-Policy' : 'Content-Security-Policy-Report-Only', CSP);
  if (env.ENVIRONMENT === 'production' && String(env.SITE_URL ?? '').startsWith('https://')) {
    res.headers.set('Strict-Transport-Security', 'max-age=31536000');
  }
  if (res.status === 429) res.headers.set('Retry-After', '60');
  return res;
}
