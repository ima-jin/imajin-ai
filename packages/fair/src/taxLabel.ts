import { authorityLabel } from './constants';
import type { FairTax } from './types';

/**
 * Display text for one `taxes[]` row, as shown by `FairAccordion` (#2439):
 * `GST/HST 13.00% (collected for CRA)`. The party named is the remittance
 * authority (`remitTo`, #2419) — not the jurisdiction code (`CA-ON`), which
 * is only the fallback when `remitTo` isn't a recognisable authority DID.
 */
export function taxLineLabel(tax: Pick<FairTax, 'kind' | 'rateBps' | 'remitTo' | 'jurisdiction'>): string {
  const collectedFor = authorityLabel(tax.remitTo) ?? tax.jurisdiction;
  return `${tax.kind} ${(tax.rateBps / 100).toFixed(2)}% (collected for ${collectedFor})`;
}
