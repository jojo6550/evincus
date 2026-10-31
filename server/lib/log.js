// One JSON object per line, readable in the Render logs. PII never reaches a log.
// PII_KEYS covers customers. `account` is staff-only (filled from stored staff accounts), so it is not in PII_KEYS
// and createLogger keeps a top-level `account` string whole, email included; every other field is fully redacted.
export const PII_KEYS = new Set(['payer', 'shipto', 'email', 'name', 'address', 'phone', 'customer', 'fulfillment', 'notes', 'authorization', 'cookie', 'setcookie', 'token', 'checkouttoken', 'password', 'secret', 'apikey', 'resendapikey', 'admintoken', 'orderhmackey', 'newsletterkey', 'body']);

export function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).filter(([k]) => !PII_KEYS.has(k.toLowerCase().replace(/[-_]/g, ''))).map(([k, v]) => [k, redact(v)]));
  }
  if (typeof value === 'string') return value
    .replace(/Bearer\s+[^\s"<>]+/gi, 'Bearer [redacted]')
    .replace(/([?&](?:t|token|key|secret)=)[^\s&#"<>]+/gi, '$1[redacted]')
    .replace(/[A-Z0-9._%+-]+(?:@|%40)[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted-email]');
  return value;
}

const SAVED = new Set(['login.ok', 'login.failed', 'login.blocked', 'account.added', 'account.removed', 'sales.updated', 'era.saved', 'product.saved', 'stock.adjusted', 'media.uploaded', 'order.placed', 'order.ready', 'order.fulfilled', 'order.cancelled', 'order.refunded', 'inventory.pulled']);

// Which lines the Logs tab keeps: errors, 500 requests, non-request warnings (so not bot 404s or 429s) and staff events.
// 503s (closed store, health, busy) are anonymous and unbounded, so their request lines are never saved.
export function shouldSave(line) {
  if (line.event === 'client.error') return false; // anonymous beacons would flood the store
  if (line.event === 'login.blocked') return line.firstBlock === true;
  if (line.event === 'request') return line.status === 500;
  if (line.level === 'error') return true;
  return line.level === 'warn' || SAVED.has(line.event);
}

export function createLogger(base = {}, { sink } = {}) {
  const write = (level, event, fields = {}) => {
    const { account, ...rest } = { ts: new Date().toISOString(), level, event, ...base, ...fields };
    const line = redact(rest);
    if (typeof account === 'string') line.account = account;
    else if (account !== undefined) line.account = redact(account);
    console.log(JSON.stringify(line));
    if (sink && shouldSave(line)) try { sink(line); } catch { /* best-effort */ }
  };
  return {
    info: (event, fields) => write('info', event, fields),
    warn: (event, fields) => write('warn', event, fields),
    error: (event, fields) => write('error', event, fields),
    child: extra => createLogger({ ...base, ...extra }, { sink }),
  };
}
