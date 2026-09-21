/**
 * Money formatting/parsing helpers shared by the payment_request UI
 * surfaces (#2211): the Money tab's create form and the public by-handle
 * pay page. Thin wrappers around `@imajin/money` — kept here (rather than
 * inline in each component) so both surfaces parse/format minor units the
 * same currency-aware way (no naive `amount / 100`, which breaks for
 * zero-decimal currencies like JPY).
 */
import { format, fromDecimalString, minorUnitExponent, toDecimalString } from '@imajin/money';

/** Locale-formatted display string for a minor-units amount, e.g. `formatMinorUnits(1999, 'USD')` -> "$19.99". */
export function formatMinorUnits(amount: number, currency: string): string {
  return format({ amount, currency });
}

/** Render minor units as a plain decimal string for editing (e.g. 1999 -> "19.99"), respecting the currency's decimal places. */
export function minorUnitsToDecimalString(amount: number, currency: string): string {
  return toDecimalString({ amount, currency });
}

/**
 * Parse a user-typed decimal string (e.g. "19.99") into minor units for
 * `currency`, or `null` when the input is empty, malformed, or not
 * strictly positive. Never uses float multiplication — parses through
 * `fromDecimalString`'s exact-rational path.
 */
export function parsePositiveDecimalAmount(value: string, currency: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const money = fromDecimalString(trimmed, currency);
    return money.amount > 0 ? money.amount : null;
  } catch {
    return null;
  }
}

export { minorUnitExponent };
