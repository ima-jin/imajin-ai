/**
 * Tax registration validation + lookup helpers (#2420).
 *
 * Format validation only — no external verification against CRA/EU/etc
 * registries. Each `kind` gets its own small validator so cognitive
 * complexity stays low and new jurisdictions/kinds can be added without
 * touching the others.
 */
import type { TaxRegistration, TaxRegistrationKind } from '@/src/db/schemas/profile';

export type { TaxRegistration, TaxRegistrationKind };

export const TAX_REGISTRATION_KINDS: readonly TaxRegistrationKind[] = ['GST/HST', 'QST', 'PST', 'VAT'];

/** Strip spaces/hyphens and uppercase — shared normalisation for every kind. */
function normalizeAlnum(raw: string): string {
  return raw.replace(/[\s-]/g, '').toUpperCase();
}

export interface TaxRegistrationNumberValidation {
  valid: boolean;
  normalized: string;
  error?: string;
}

// CRA Business Number + program account: 9 digits, 'RT', 4 digits.
const GST_HST_RE = /^\d{9}RT\d{4}$/;
function validateGstHst(rawNumber: string): TaxRegistrationNumberValidation {
  const normalized = normalizeAlnum(rawNumber);
  if (!GST_HST_RE.test(normalized)) {
    return {
      valid: false,
      normalized,
      error: 'GST/HST number must be 9 digits, "RT", then 4 digits (e.g. 123456789RT0001)',
    };
  }
  return { valid: true, normalized };
}

// Quebec QST: 10 digits, 'TQ', 4 digits.
const QST_RE = /^\d{10}TQ\d{4}$/;
function validateQst(rawNumber: string): TaxRegistrationNumberValidation {
  const normalized = normalizeAlnum(rawNumber);
  if (!QST_RE.test(normalized)) {
    return {
      valid: false,
      normalized,
      error: 'QST number must be 10 digits, "TQ", then 4 digits (e.g. 1234567890TQ0001)',
    };
  }
  return { valid: true, normalized };
}

// ISO-3166 alpha-2 country prefix followed by 2-13 alphanumeric characters —
// a generic shape check spanning EU/UK/CH-style VAT numbers without a
// hard-coded per-country length table.
const VAT_RE = /^[A-Z]{2}[A-Z0-9]{2,13}$/;
function validateVat(rawNumber: string): TaxRegistrationNumberValidation {
  const normalized = normalizeAlnum(rawNumber);
  if (!VAT_RE.test(normalized)) {
    return {
      valid: false,
      normalized,
      error: 'VAT number must start with a 2-letter country code followed by 2-13 alphanumeric characters (e.g. GB123456789)',
    };
  }
  return { valid: true, normalized };
}

// PST numbers vary by jurisdiction. Known jurisdictions get an exact digit
// count; unknown ones fall back to a permissive alphanumeric length range
// rather than rejecting outright.
const PST_JURISDICTION_DIGIT_LENGTHS: Readonly<Record<string, number>> = {
  'CA-BC': 8,
  'CA-SK': 7,
  'CA-MB': 7,
};
const PST_DEFAULT_LENGTH_RANGE: readonly [number, number] = [6, 10];

function validatePstWithLength(normalized: string, length: number, jurisdiction: string): TaxRegistrationNumberValidation {
  const pattern = String.raw`^\d{${length}}$`;
  if (!new RegExp(pattern).test(normalized)) {
    return { valid: false, normalized, error: `PST number for ${jurisdiction} must be ${length} digits` };
  }
  return { valid: true, normalized };
}

function validatePstDefault(normalized: string): TaxRegistrationNumberValidation {
  const [min, max] = PST_DEFAULT_LENGTH_RANGE;
  if (!/^[A-Z0-9]+$/.test(normalized) || normalized.length < min || normalized.length > max) {
    return { valid: false, normalized, error: `PST number must be ${min}-${max} alphanumeric characters` };
  }
  return { valid: true, normalized };
}

function validatePst(jurisdiction: string, rawNumber: string): TaxRegistrationNumberValidation {
  const normalized = normalizeAlnum(rawNumber).replace(/^PST/, '');
  const expectedLength = PST_JURISDICTION_DIGIT_LENGTHS[jurisdiction];
  return expectedLength === undefined
    ? validatePstDefault(normalized)
    : validatePstWithLength(normalized, expectedLength, jurisdiction);
}

/** Format-only validation for a single registration number, per kind (#2420). No external verification. */
export function validateTaxRegistrationNumber(
  kind: TaxRegistrationKind,
  jurisdiction: string,
  rawNumber: string
): TaxRegistrationNumberValidation {
  switch (kind) {
    case 'GST/HST':
      return validateGstHst(rawNumber);
    case 'QST':
      return validateQst(rawNumber);
    case 'VAT':
      return validateVat(rawNumber);
    case 'PST':
      return validatePst(jurisdiction, rawNumber);
    default:
      return { valid: false, normalized: rawNumber, error: `Unknown tax registration kind: ${kind}` };
  }
}

export interface TaxRegistrationValidationResult {
  valid: boolean;
  error?: string;
  normalized?: TaxRegistration;
}

/** Validate one raw registration's shape, then its number format. Returns the normalized registration on success. */
export function validateTaxRegistration(input: unknown): TaxRegistrationValidationResult {
  if (typeof input !== 'object' || input === null) {
    return { valid: false, error: 'Each tax registration must be an object' };
  }
  const { jurisdiction, kind, number, label } = input as Record<string, unknown>;

  if (typeof jurisdiction !== 'string' || jurisdiction.trim() === '') {
    return { valid: false, error: 'jurisdiction is required' };
  }
  if (typeof kind !== 'string' || !TAX_REGISTRATION_KINDS.includes(kind as TaxRegistrationKind)) {
    return { valid: false, error: `kind must be one of ${TAX_REGISTRATION_KINDS.join(', ')}` };
  }
  if (typeof number !== 'string' || number.trim() === '') {
    return { valid: false, error: 'number is required' };
  }
  if (label !== undefined && typeof label !== 'string') {
    return { valid: false, error: 'label must be a string' };
  }

  const numberCheck = validateTaxRegistrationNumber(kind as TaxRegistrationKind, jurisdiction, number);
  if (!numberCheck.valid) {
    return { valid: false, error: numberCheck.error };
  }

  const normalized: TaxRegistration = { jurisdiction, kind: kind as TaxRegistrationKind, number: numberCheck.normalized };
  if (label !== undefined) normalized.label = label as string;
  return { valid: true, normalized };
}

export interface TaxRegistrationsValidationResult {
  valid: boolean;
  errors?: string[];
  normalized?: TaxRegistration[];
}

/** Validate + normalise an entire `tax_registrations` array (#2420). */
export function validateTaxRegistrations(input: unknown): TaxRegistrationsValidationResult {
  if (!Array.isArray(input)) {
    return { valid: false, errors: ['taxRegistrations must be an array'] };
  }

  const errors: string[] = [];
  const normalized: TaxRegistration[] = [];
  input.forEach((entry, index) => {
    const result = validateTaxRegistration(entry);
    if (!result.valid || !result.normalized) {
      errors.push(`taxRegistrations[${index}]: ${result.error ?? 'invalid'}`);
      return;
    }
    normalized.push(result.normalized);
  });

  return errors.length > 0 ? { valid: false, errors } : { valid: true, normalized };
}

/**
 * Return the "primary" tax registration for a profile (#2420) — a small
 * shared helper for #2421 (pay service tax-rate prefill) to consume.
 *
 * With no `jurisdiction`, the first registration on file is treated as
 * primary. With a `jurisdiction`, the first registration matching it is
 * returned, or `null` if the business isn't registered there.
 */
export function getPrimaryTaxRegistration(
  profile: { taxRegistrations?: TaxRegistration[] | null } | null | undefined,
  jurisdiction?: string
): TaxRegistration | null {
  const registrations = profile?.taxRegistrations ?? [];
  if (registrations.length === 0) return null;
  if (jurisdiction) {
    return registrations.find((reg) => reg.jurisdiction === jurisdiction) ?? null;
  }
  return registrations[0];
}
