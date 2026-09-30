import { add as moneyAdd, type Money } from '@imajin/money';
import {
  computeTaxAmountMinor,
  defaultTaxRateBps,
  parseRatePercentToBps,
  rateBpsToPercentInput,
} from '@/src/lib/pay/payment-requests/tax-rates';
import type { TaxRegistration } from '@/src/lib/profile/tax-registrations';
import type { TaxRowDraft } from './types';

/**
 * Money-tab side of payment_request tax (#2421). Everything here is a
 * PREVIEW plus the request fields the create route validates — the server
 * rebuilds every `taxes[]` row (registration number from the issuer's
 * profile, amount from `rate_bps` × the server-computed subtotal) and 400s
 * on any amount that disagrees with what this module computed.
 */

export interface TaxPreviewRow {
  key: string;
  jurisdiction: string;
  kind: string;
  rateBps: number;
  /** Minor units. */
  amount: number;
}

export interface TaxPreview {
  /** Minor units, all of them. `total === subtotal + taxTotal`. */
  subtotal: number;
  rows: TaxPreviewRow[];
  taxTotal: number;
  total: number;
}

export type TaxPreviewResult = { ok: true; value: TaxPreview } | { ok: false; error: string };

/**
 * One draft row per registration on the issuer's business profile, all
 * included, with the rate prefilled from the static default-rate table
 * (jurisdiction + kind → integer bps). No table entry (e.g. Quebec QST at
 * 9.975%, which is not a whole number of bps) → blank, and required.
 */
export function draftsFromRegistrations(registrations: readonly TaxRegistration[]): TaxRowDraft[] {
  return registrations.map((reg) => {
    const defaultBps = defaultTaxRateBps(reg.jurisdiction, reg.kind);
    return {
      key: `${reg.jurisdiction}|${reg.kind}|${reg.number}`,
      jurisdiction: reg.jurisdiction,
      kind: reg.kind,
      number: reg.number,
      included: true,
      rate: defaultBps === null ? '' : rateBpsToPercentInput(defaultBps),
    };
  });
}

function fail(error: string): TaxPreviewResult {
  return { ok: false, error };
}

/**
 * Subtotal → per-registration tax → total, in integer minor units via
 * `packages/money` (no floats). A rate is required for every charged
 * registration; a rate that isn't a whole number of basis points is an
 * error rather than being rounded.
 */
export function buildTaxPreview(subtotalAmount: number, currency: string, drafts: readonly TaxRowDraft[]): TaxPreviewResult {
  const charged = drafts.filter((draft) => draft.included);
  if (charged.length === 0) {
    return fail('Pick at least one tax registration to charge, or turn off "Charge tax"');
  }

  const rows: TaxPreviewRow[] = [];
  let taxTotal: Money = { amount: 0, currency };
  for (const draft of charged) {
    const label = `${draft.kind} (${draft.jurisdiction})`;
    if (!draft.rate.trim()) return fail(`Enter a rate for ${label}`);
    const parsed = parseRatePercentToBps(draft.rate);
    if (!parsed.ok) return fail(`${label}: ${parsed.error}`);

    const amount = computeTaxAmountMinor(subtotalAmount, parsed.rateBps);
    rows.push({ key: draft.key, jurisdiction: draft.jurisdiction, kind: draft.kind, rateBps: parsed.rateBps, amount });
    taxTotal = moneyAdd(taxTotal, { amount, currency });
  }

  const total = moneyAdd({ amount: subtotalAmount, currency }, taxTotal);
  return { ok: true, value: { subtotal: subtotalAmount, rows, taxTotal: taxTotal.amount, total: total.amount } };
}

export type TaxFieldsResult = { ok: true; value: Record<string, unknown> } | { ok: false; error: string };

/**
 * The tax fields of the `POST /pay/api/payment-requests` body: nothing at all
 * when "Charge tax" is off (the body is then identical to what it was before
 * tax existed), otherwise `charge_tax`, one `taxes[]` row per charged
 * registration and the previewed subtotal/tax/total the server re-checks.
 */
export function buildTaxFields(
  chargeTax: boolean,
  drafts: readonly TaxRowDraft[],
  subtotalAmount: number,
  currency: string,
): TaxFieldsResult {
  if (!chargeTax) return { ok: true, value: {} };

  const preview = buildTaxPreview(subtotalAmount, currency, drafts);
  if (!preview.ok) return preview;

  const { rows, subtotal, taxTotal, total } = preview.value;
  return {
    ok: true,
    value: {
      charge_tax: true,
      taxes: rows.map((row) => ({
        jurisdiction: row.jurisdiction,
        kind: row.kind,
        rate_bps: row.rateBps,
        amount: row.amount,
      })),
      subtotal_amount: subtotal,
      tax_total_amount: taxTotal,
      total_amount: total,
    },
  };
}
