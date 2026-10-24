// One JSON object per line, readable in the Render logs. PII never reaches a log.
export const PII_KEYS = new Set(['payer', 'shipto', 'email', 'name', 'address', 'phone', 'customer', 'fulfillment', 'notes', 'authorization', 'cookie', 'setcookie', 'token', 'checkouttoken', 'password', 'secret', 'apikey', 'resendapikey', 'admintoken', 'orderhmackey', 'newsletterkey', 'body']);

export function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).filter(([k]) => !PII_KEYS.has(k.toLowerCase().replace(/[-_]/g, ''))).map(([k, v]) => [k, redact(v)]));
  }
  if (typeof value === 'string') return value
    .replace(/Bearer\s+[^\s"<>]+/gi, 'Bearer [redacted]')
    .replace(/([?&](?:t|token|key|secret)=)[^\s&#"<>]+/gi, '$1[redacted]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted-email]');
  return value;
}

export function createLogger(base = {}) {
  const write = (level, event, fields = {}) =>
    console.log(JSON.stringify(redact({ ts: new Date().toISOString(), level, event, ...base, ...fields })));
  return {
    info: (event, fields) => write('info', event, fields),
    warn: (event, fields) => write('warn', event, fields),
    error: (event, fields) => write('error', event, fields),
    child: extra => createLogger({ ...base, ...extra }),
  };
}
