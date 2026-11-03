import { validDataKey } from './crypto.js';

// Settings production refuses to start without. WiPay may be unset (payments off), but never half set, sandbox, or
// the public test key, so a test card can never mark a live order paid. -> human-readable errors, [] when fine.
export function productionConfigErrors(env) {
  const errors = [];
  const keys = ['ADMIN_TOKEN', 'NEWSLETTER_KEY'];
  if (keys.some(key => !env[key] || env[key].length < 32 || /local-dev-only|example/i.test(env[key])) || new Set(keys.map(key => env[key])).size !== keys.length) {
    errors.push('Production requires distinct ADMIN_TOKEN and NEWSLETTER_KEY secrets of at least 32 characters');
  }
  if (!validDataKey(env.CUSTOMER_DATA_KEY)) errors.push('CUSTOMER_DATA_KEY must be 32 random bytes, base64');
  else if (keys.some(key => env[key] === env.CUSTOMER_DATA_KEY)) errors.push('CUSTOMER_DATA_KEY must differ from ADMIN_TOKEN and NEWSLETTER_KEY');
  if (env.WIPAY_ACCOUNT_NUMBER || env.WIPAY_API_KEY) {
    if (!env.WIPAY_ACCOUNT_NUMBER || !env.WIPAY_API_KEY) errors.push('Set both WIPAY_ACCOUNT_NUMBER and WIPAY_API_KEY, or neither');
    if (env.WIPAY_ENVIRONMENT !== 'live') errors.push('WIPAY_ENVIRONMENT must be live in production');
    if (env.WIPAY_API_KEY === '123') errors.push("WIPAY_API_KEY is WiPay's public sandbox key");
  }
  return errors;
}
