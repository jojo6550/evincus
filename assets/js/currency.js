// Prices in the visitor's currency, as estimates. Checkout, WiPay, receipts and policies always state USD.
import { money } from '../../data/catalog.js';
import { COUNTRIES } from '../../data/countries.js';

const KEY = 'evincus_currency';
let rates = { USD: 1 };
let code = 'USD';
const listeners = new Set();

const rated = (c, r) => c === 'USD' || (typeof r[c] === 'number' && Number.isFinite(r[c]) && r[c] > 0);

// The first BCP 47 tag with a region decides (en-JM → JM → JMD); none, or a currency without a rate, is USD.
export function detectCurrency(languages, r) {
  for (const tag of languages ?? []) {
    const region = String(tag).split('-').slice(1).find(p => /^[A-Za-z]{2}$/.test(p));
    if (!region) continue;
    const c = COUNTRIES[region.toUpperCase()];
    return c && rated(c, r) ? c : 'USD';
  }
  return 'USD';
}

const digits = c => { try { return new Intl.NumberFormat('en', { style: 'currency', currency: c }).resolvedOptions().maximumFractionDigits; } catch { return 2; } };

export function formatIn(cents, c, r, locale = 'en') {
  if (c === 'USD' || !rated(c, r)) return money(cents);
  const d = digits(c);
  return `≈ ${c} ${new Intl.NumberFormat(locale, { minimumFractionDigits: d, maximumFractionDigits: d }).format((cents / 100) * r[c])}`;
}

export const formatPrice = cents => formatIn(cents, code, rates);
export const currentCurrency = () => code;
export const onCurrencyChange = fn => { listeners.add(fn); };
const choose = c => { code = c; listeners.forEach(fn => fn(c)); };

const read = storage => { try { return storage?.getItem(KEY) ?? null; } catch { return null; } };
const write = (storage, c) => { try { storage?.setItem(KEY, c); } catch { /* storage blocked: the choice lasts this page */ } };
const defaultStorage = () => { try { return globalThis.localStorage; } catch { return null; } };

// Loads the rates and shows the picker. Without rates it stays hidden and every price is USD.
export async function initCurrency(select, credit, {
  load = async () => (await import('./api.js')).api('GET', '/api/currencies'),
  storage = defaultStorage(), languages = globalThis.navigator?.languages,
} = {}) {
  rates = { USD: 1 };
  code = 'USD';
  let data;
  try { data = await load(); } catch { return; }
  rates = Object.fromEntries(Object.entries(data?.rates ?? {}).filter(([c]) => rated(c, data.rates)));
  rates.USD = 1;
  const codes = Object.keys(rates);
  if (codes.length < 2) return;
  const stored = read(storage);
  const start = stored && rated(stored, rates) ? stored : detectCurrency(languages, rates);
  if (select) {
    let names;
    try { names = new Intl.DisplayNames(undefined, { type: 'currency' }); } catch { names = null; }
    select.innerHTML = codes.map(c => [c, names?.of(c) ?? c]).sort((a, b) => a[1].localeCompare(b[1]))
      .map(([c, name]) => `<option value="${c}">${c} · ${name.replace(/[&<>"]/g, '')}</option>`).join('');
    select.value = start;
    select.hidden = false;
    select.addEventListener('change', () => { write(storage, select.value); choose(select.value); });
  }
  if (credit) credit.hidden = false;
  if (start !== 'USD') choose(start);
}
