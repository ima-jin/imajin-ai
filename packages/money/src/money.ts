/**
 * `Money` — an integer minor-unit amount plus an ISO-4217 currency code.
 *
 * `amount` is a plain JS `number` rather than `bigint`. `packages/fair` has
 * embedded a `{ amount: number, currency: string }` shape directly in
 * signed, on-disk `.fair` manifests (v1.0/v1.1) since before this package
 * existed; `JSON.stringify` cannot serialize `bigint` at all, so keeping
 * `Money` a plain JSON-safe object is what lets `fair` re-export this type
 * with zero changes to its manifest schema or existing object-literal call
 * sites (see fair/src/types.ts). "No floats" describes the arithmetic, not
 * the field type: every function below does its actual computation in
 * `bigint` (via decimal.ts) and only converts back to `number` after
 * confirming the result is still an exact safe integer — see
 * `bigintToSafeNumber`, which throws `MoneyOverflowError` rather than ever
 * silently rounding through a float.
 */

import { CurrencyMismatchError } from './errors';
import { minorUnitExponent } from './currency';
import {
  type Rational,
  bigintToSafeNumber,
  fractionToDecimalString,
  parseDecimalToFraction,
  roundHalfEven,
} from './decimal';

export interface Money {
  readonly amount: number;
  readonly currency: string;
}

/** A multiplier: a whole number, an exact rational, or a decimal string (parsed exactly, never as a float). */
export type MultiplyFactor = bigint | Rational | string;

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new CurrencyMismatchError(a.currency, b.currency);
  }
}

export function add(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return { amount: bigintToSafeNumber(BigInt(a.amount) + BigInt(b.amount), 'Money.add'), currency: a.currency };
}

export function subtract(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return { amount: bigintToSafeNumber(BigInt(a.amount) - BigInt(b.amount), 'Money.subtract'), currency: a.currency };
}

function toRational(factor: MultiplyFactor): Rational {
  if (typeof factor === 'bigint') return { numerator: factor, denominator: 1n };
  if (typeof factor === 'string') return parseDecimalToFraction(factor);
  return factor;
}

/** Multiply by an exact rational factor (e.g. a tax or discount rate), banker's-rounded to the nearest minor unit. */
export function multiply(money: Money, factor: MultiplyFactor): Money {
  const { numerator, denominator } = toRational(factor);
  const rounded = roundHalfEven(BigInt(money.amount) * numerator, denominator);
  return { amount: bigintToSafeNumber(rounded, 'Money.multiply'), currency: money.currency };
}

export function equals(a: Money, b: Money): boolean {
  return a.amount === b.amount && a.currency === b.currency;
}

/** Parse a human decimal string (e.g. "19.99") into minor units for `currency`, banker's-rounded if over-precise. */
export function fromDecimalString(value: string, currency: string): Money {
  const exponent = minorUnitExponent(currency);
  const { numerator, denominator } = parseDecimalToFraction(value);
  const minor = roundHalfEven(numerator * 10n ** BigInt(exponent), denominator);
  return { amount: bigintToSafeNumber(minor, 'Money.fromDecimalString'), currency };
}

/** Render minor units back to a human decimal string (e.g. 1999 USD -> "19.99"). */
export function toDecimalString(money: Money): string {
  const exponent = minorUnitExponent(money.currency);
  return fractionToDecimalString({ numerator: BigInt(money.amount), denominator: 10n ** BigInt(exponent) }, exponent);
}

/**
 * Locale-formatted display string, e.g. `format({amount: 1999, currency: 'USD'}, 'en-US')` -> "$19.99".
 * Display-only: converts to a JS `number` via `Intl.NumberFormat`, which is
 * fine for rendering but must never be used as an intermediate in further
 * money math.
 */
export function format(money: Money, locale?: string): string {
  const decimal = Number(toDecimalString(money));
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency: money.currency }).format(decimal);
  } catch {
    // Intl throws RangeError for currency codes it doesn't recognise (e.g.
    // fair's non-ISO 'MJNX'). Fall back to a plain rendering instead of
    // crashing formatting for those.
    return `${decimal.toFixed(minorUnitExponent(money.currency))} ${money.currency}`;
  }
}
