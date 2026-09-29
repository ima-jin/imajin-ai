import { describe, it, expect } from 'vitest';
import {
  TAX_REGISTRATION_KINDS,
  validateTaxRegistrationNumber,
  validateTaxRegistration,
  validateTaxRegistrations,
  getPrimaryTaxRegistration,
} from '../tax-registrations';

describe('TAX_REGISTRATION_KINDS', () => {
  it('lists the four supported kinds', () => {
    expect(TAX_REGISTRATION_KINDS).toEqual(['GST/HST', 'QST', 'PST', 'VAT']);
  });
});

describe('validateTaxRegistrationNumber — GST/HST', () => {
  it('accepts a valid CRA Business Number + program account', () => {
    const result = validateTaxRegistrationNumber('GST/HST', 'CA-ON', '123456789RT0001');
    expect(result.valid).toBe(true);
    expect(result.normalized).toBe('123456789RT0001');
  });

  it('accepts spaces and hyphens, normalising them away', () => {
    const result = validateTaxRegistrationNumber('GST/HST', 'CA-ON', '123 456 789 RT 0001');
    expect(result.valid).toBe(true);
    expect(result.normalized).toBe('123456789RT0001');

    const hyphenated = validateTaxRegistrationNumber('GST/HST', 'CA-ON', '123-456-789-RT-0001');
    expect(hyphenated.valid).toBe(true);
    expect(hyphenated.normalized).toBe('123456789RT0001');
  });

  it('normalises lowercase program account letters', () => {
    const result = validateTaxRegistrationNumber('GST/HST', 'CA-ON', '123456789rt0001');
    expect(result.valid).toBe(true);
    expect(result.normalized).toBe('123456789RT0001');
  });

  it('rejects the wrong number of digits', () => {
    const result = validateTaxRegistrationNumber('GST/HST', 'CA-ON', '12345RT0001');
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/9 digits/);
  });

  it('rejects a program account that is not RT', () => {
    const result = validateTaxRegistrationNumber('GST/HST', 'CA-ON', '123456789XX0001');
    expect(result.valid).toBe(false);
  });
});

describe('validateTaxRegistrationNumber — QST', () => {
  it('accepts a valid 10-digit + TQ + 4-digit number', () => {
    const result = validateTaxRegistrationNumber('QST', 'CA-QC', '1234567890TQ0001');
    expect(result.valid).toBe(true);
    expect(result.normalized).toBe('1234567890TQ0001');
  });

  it('normalises spaces/hyphens and lowercase', () => {
    const result = validateTaxRegistrationNumber('QST', 'CA-QC', '1234567890-tq-0001');
    expect(result.valid).toBe(true);
    expect(result.normalized).toBe('1234567890TQ0001');
  });

  it('rejects an incorrect digit count', () => {
    const result = validateTaxRegistrationNumber('QST', 'CA-QC', '123456789TQ0001');
    expect(result.valid).toBe(false);
  });
});

describe('validateTaxRegistrationNumber — VAT', () => {
  it('accepts an ISO-country-prefixed alphanumeric VAT number', () => {
    const result = validateTaxRegistrationNumber('VAT', 'GB', 'GB123456789');
    expect(result.valid).toBe(true);
    expect(result.normalized).toBe('GB123456789');
  });

  it('normalises spaces and lowercase', () => {
    const result = validateTaxRegistrationNumber('VAT', 'DE', 'de 123 456 789');
    expect(result.valid).toBe(true);
    expect(result.normalized).toBe('DE123456789');
  });

  it('rejects a number missing the country prefix', () => {
    const result = validateTaxRegistrationNumber('VAT', 'GB', '123456789');
    expect(result.valid).toBe(false);
  });

  it('rejects a number that is too short after the prefix', () => {
    const result = validateTaxRegistrationNumber('VAT', 'GB', 'GB1');
    expect(result.valid).toBe(false);
  });
});

describe('validateTaxRegistrationNumber — PST', () => {
  it('enforces the known BC digit length', () => {
    const valid = validateTaxRegistrationNumber('PST', 'CA-BC', 'PST-1234-5678');
    expect(valid.valid).toBe(true);
    expect(valid.normalized).toBe('12345678');

    const invalid = validateTaxRegistrationNumber('PST', 'CA-BC', 'PST-1234-567');
    expect(invalid.valid).toBe(false);
    expect(invalid.error).toMatch(/8 digits/);
  });

  it('enforces the known Saskatchewan/Manitoba 7-digit length', () => {
    expect(validateTaxRegistrationNumber('PST', 'CA-SK', '1234567').valid).toBe(true);
    expect(validateTaxRegistrationNumber('PST', 'CA-MB', '1234567').valid).toBe(true);
    expect(validateTaxRegistrationNumber('PST', 'CA-SK', '123456').valid).toBe(false);
  });

  it('falls back to a permissive alphanumeric range for unknown jurisdictions', () => {
    expect(validateTaxRegistrationNumber('PST', 'CA-XX', 'ABC1234').valid).toBe(true);
    expect(validateTaxRegistrationNumber('PST', 'CA-XX', 'AB').valid).toBe(false);
    expect(validateTaxRegistrationNumber('PST', 'CA-XX', 'A'.repeat(20)).valid).toBe(false);
  });
});

describe('validateTaxRegistration', () => {
  it('validates and normalises a well-formed registration with a label', () => {
    const result = validateTaxRegistration({
      jurisdiction: 'CA-ON',
      kind: 'GST/HST',
      number: '123 456 789 RT 0001',
      label: 'Head office',
    });
    expect(result.valid).toBe(true);
    expect(result.normalized).toEqual({
      jurisdiction: 'CA-ON',
      kind: 'GST/HST',
      number: '123456789RT0001',
      label: 'Head office',
    });
  });

  it('omits label when not provided', () => {
    const result = validateTaxRegistration({ jurisdiction: 'CA-ON', kind: 'GST/HST', number: '123456789RT0001' });
    expect(result.valid).toBe(true);
    expect(result.normalized).toEqual({ jurisdiction: 'CA-ON', kind: 'GST/HST', number: '123456789RT0001' });
  });

  it('rejects a non-object input', () => {
    expect(validateTaxRegistration('nope').valid).toBe(false);
    expect(validateTaxRegistration(null).valid).toBe(false);
  });

  it('rejects a missing jurisdiction', () => {
    const result = validateTaxRegistration({ jurisdiction: '', kind: 'GST/HST', number: '123456789RT0001' });
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/jurisdiction/);
  });

  it('rejects an unknown kind', () => {
    const result = validateTaxRegistration({ jurisdiction: 'CA-ON', kind: 'INCOME_TAX', number: '123456789RT0001' });
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/kind must be one of/);
  });

  it('rejects a missing number', () => {
    const result = validateTaxRegistration({ jurisdiction: 'CA-ON', kind: 'GST/HST', number: '' });
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/number/);
  });

  it('rejects a non-string label', () => {
    const result = validateTaxRegistration({ jurisdiction: 'CA-ON', kind: 'GST/HST', number: '123456789RT0001', label: 42 });
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/label/);
  });

  it('rejects an invalid number format, surfacing the kind-specific error', () => {
    const result = validateTaxRegistration({ jurisdiction: 'CA-ON', kind: 'GST/HST', number: 'not-a-number' });
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/9 digits/);
  });
});

describe('validateTaxRegistrations', () => {
  it('rejects a non-array input', () => {
    const result = validateTaxRegistrations({ jurisdiction: 'CA-ON' });
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(['taxRegistrations must be an array']);
  });

  it('accepts an empty array', () => {
    const result = validateTaxRegistrations([]);
    expect(result.valid).toBe(true);
    expect(result.normalized).toEqual([]);
  });

  it('validates and normalises every entry in a valid list', () => {
    const result = validateTaxRegistrations([
      { jurisdiction: 'CA-ON', kind: 'GST/HST', number: '123-456-789-RT-0001' },
      { jurisdiction: 'CA-QC', kind: 'QST', number: '1234567890TQ0001' },
    ]);
    expect(result.valid).toBe(true);
    expect(result.normalized).toEqual([
      { jurisdiction: 'CA-ON', kind: 'GST/HST', number: '123456789RT0001' },
      { jurisdiction: 'CA-QC', kind: 'QST', number: '1234567890TQ0001' },
    ]);
  });

  it('collects per-index errors for every invalid entry, without short-circuiting', () => {
    const result = validateTaxRegistrations([
      { jurisdiction: 'CA-ON', kind: 'GST/HST', number: 'bad' },
      { jurisdiction: '', kind: 'VAT', number: 'GB123456789' },
    ]);
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(2);
    expect(result.errors?.[0]).toMatch(/^taxRegistrations\[0\]/);
    expect(result.errors?.[1]).toMatch(/^taxRegistrations\[1\]/);
  });
});

describe('getPrimaryTaxRegistration', () => {
  const registrations = [
    { jurisdiction: 'CA-ON', kind: 'GST/HST' as const, number: '123456789RT0001' },
    { jurisdiction: 'CA-QC', kind: 'QST' as const, number: '1234567890TQ0001' },
  ];

  it('returns null when the profile has no registrations', () => {
    expect(getPrimaryTaxRegistration(null)).toBeNull();
    expect(getPrimaryTaxRegistration({ taxRegistrations: [] })).toBeNull();
    expect(getPrimaryTaxRegistration(undefined)).toBeNull();
  });

  it('returns the first registration when no jurisdiction is given', () => {
    expect(getPrimaryTaxRegistration({ taxRegistrations: registrations })).toEqual(registrations[0]);
  });

  it('returns the registration matching the given jurisdiction', () => {
    expect(getPrimaryTaxRegistration({ taxRegistrations: registrations }, 'CA-QC')).toEqual(registrations[1]);
  });

  it('returns null when no registration matches the given jurisdiction', () => {
    expect(getPrimaryTaxRegistration({ taxRegistrations: registrations }, 'US-NY')).toBeNull();
  });
});
