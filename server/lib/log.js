// One JSON object per line, readable in the Deno Deploy logs. PII never reaches a log.
export const PII_KEYS = new Set(['payer', 'shipTo', 'email', 'name', 'address', 'phone']);

export function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).filter(([k]) => !PII_KEYS.has(k)).map(([k, v]) => [k, redact(v)]));
  }
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
