/**
 * Static default tax rates + integer basis-point math for payment_request
 * tax (#2421). Pure and dependency-free so both the server (`tax.ts`,
 * `service.ts`) and the Money tab's create form can import it — the form
 * uses it for the live subtotal → tax → total preview, the server
 * re-derives every amount itself and never trusts the client's.
 *
 * `TaxRegistration` (#2420) carries NO rate, and a rate column on the
 * profile is out of scope — so the "prefilled rate" comes from the small
 * static table below, keyed by jurisdiction + kind, in integer basis
 * points (`FairTax.rateBps`, e.g. 1300 = 13%).
 *
 * A rate that is not a whole number of basis points (Quebec QST is 9.975% =
 * 997.5 bps) must NEVER be silently rounded, so it is deliberately absent
 * from the table: the field stays blank and the issuer has to decide (see
 * the DECISION card on the PR).
 */

/** Rates in effect per CRA (Canada.ca "Charge and collect the GST/HST", 2026-04-08): NS HST 14% since 2025-04-01; NB/NL/PE HST 15%; ON HST 13%; everywhere else GST 5%. */
const DEFAULT_RATES_BPS: Readonly<Record<string, number>> = {
  'CA-ON|GST/HST': 1300,
  'CA-NS|GST/HST': 1400,
  'CA-NB|GST/HST': 1500,
  'CA-NL|GST/HST': 1500,
  'CA-PE|GST/HST': 1500,
  'CA-AB|GST/HST': 500,
  'CA-BC|GST/HST': 500,
  'CA-MB|GST/HST': 500,
  'CA-QC|GST/HST': 500,
  'CA-SK|GST/HST': 500,
  'CA-YT|GST/HST': 500,
  'CA-NT|GST/HST': 500,
  'CA-NU|GST/HST': 500,
  'CA-BC|PST': 700,
  'CA-MB|PST': 700,
  'CA-SK|PST': 600,
  // Intentionally absent: 'CA-QC|QST' (9.975% = 997.5 bps — not an integer number of bps).
};

/** Default rate (integer bps) for a registration's jurisdiction + kind, or `null` when there is no safe integer-bps default — the caller must leave the rate blank and require the issuer to enter one. */
export function defaultTaxRateBps(jurisdiction: string, kind: string): number | null {
  return DEFAULT_RATES_BPS[`${jurisdiction}|${kind}`] ?? null;
}

const BPS_DENOMINATOR = 10_000n;

/**
 * `round(basis × rateBps / 10000)` in integer minor units, computed with
 * bigint arithmetic (no floats). Rounds half up — the same convention as
 * `packages/fair`'s `computeTaxRows` and the `taxes[].amount` validators
 * (`Math.round`), so the amount the form previews is byte-identical to the
 * `FairTax.amount` the manifest stores. (`@imajin/money`'s `multiply`
 * rounds half-even, which would disagree with those validators on exact
 * halves; it is still used for every add/compare on Money values.)
 */
export function computeTaxAmountMinor(basisAmount: number, rateBps: number): number {
  if (!Number.isSafeInteger(basisAmount) || basisAmount < 0) {
    throw new RangeError('basisAmount must be a non-negative integer (minor units)');
  }
  if (!Number.isSafeInteger(rateBps) || rateBps < 0) {
    throw new RangeError('rateBps must be a non-negative integer');
  }
  const numerator = BigInt(basisAmount) * BigInt(rateBps);
  return Number((2n * numerator + BPS_DENOMINATOR) / (2n * BPS_DENOMINATOR));
}

export type ParsedRate = { ok: true; rateBps: number } | { ok: false; error: string };

const MAX_RATE_BPS = 10_000;
const PERCENT_RE = /^(\d{1,3})(?:\.(\d+))?$/;

/**
 * Parse a user-typed percentage ("13", "5", "9.97") into integer bps
 * without floats. More than two decimal places is an error, never rounded
 * (9.975% is 997.5 bps and cannot be represented exactly).
 */
export function parseRatePercentToBps(input: string): ParsedRate {
  const match = PERCENT_RE.exec(input.trim());
  if (!match) return { ok: false, error: 'Enter the rate as a percentage, e.g. 13 or 9.97' };
  const [, whole, fraction = ''] = match;
  if (fraction.length > 2) {
    return {
      ok: false,
      error: `${input.trim()}% is not a whole number of basis points (max 2 decimal places) — it can't be recorded exactly`,
    };
  }
  const rateBps = Number.parseInt(whole, 10) * 100 + Number.parseInt(fraction.padEnd(2, '0'), 10);
  if (rateBps > MAX_RATE_BPS) return { ok: false, error: 'Rate cannot exceed 100%' };
  return { ok: true, rateBps };
}

/** Render integer bps as a percentage string with no float math: 1300 → "13%", 997 → "9.97%", 1050 → "10.5%". */
export function formatRateBps(rateBps: number): string {
  const whole = Math.trunc(rateBps / 100);
  const hundredths = rateBps % 100;
  if (hundredths === 0) return `${whole}%`;
  const digits = String(hundredths).padStart(2, '0');
  const fraction = digits.endsWith('0') ? digits.slice(0, 1) : digits;
  return `${whole}.${fraction}%`;
}

/** The rate as an editable percent string for an input field: 1300 → "13", 997 → "9.97". */
export function rateBpsToPercentInput(rateBps: number): string {
  return formatRateBps(rateBps).slice(0, -1);
}
