// Changing a rate is a commit, not a setting. Shared by the site and the API.
export const TAX = { label: 'GCT', bps: 1500 };
// WiPay Basic Free plan: 4.20% plus 15% GCT on the fee. A paid plan (3.80%) would be 437.
export const PROCESSING_FEE = { label: 'Processing fee', bps: 483 };

const part = (cents, bps) => Math.floor((cents * bps + 5000) / 10000); // half-up to the cent

// The fee is on the amount charged, which includes GCT.
export function charges(subtotalCents) {
  const taxCents = part(subtotalCents, TAX.bps);
  const feeCents = part(subtotalCents + taxCents, PROCESSING_FEE.bps);
  return { taxCents, feeCents, totalCents: subtotalCents + taxCents + feeCents };
}
