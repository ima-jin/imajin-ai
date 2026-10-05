/**
 * Unit tests for the /jin "Provision app" client-side validation (#2559) —
 * must stay in step with the limits in `POST /api/apps/provision`.
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_APP_TEMPLATE,
  MAX_ATTESTATION_TYPES,
  MAX_DISPLAY_NAME_LENGTH,
  buildProvisionPayload,
  hasProvisionErrors,
  isGithubRepoUrl,
  isLedgerNewerThanDecision,
  isPendingCardExpired,
  parseAttestationTypes,
  validateProvisionForm,
  type ProvisionFormValues,
} from '../provision-app-validation';

function values(overrides: Partial<ProvisionFormValues> = {}): ProvisionFormValues {
  return { slug: 'coffee', displayName: 'Coffee', template: DEFAULT_APP_TEMPLATE, attestationTypes: '', ...overrides };
}

describe('parseAttestationTypes', () => {
  it('splits on commas and whitespace, dropping blanks and duplicates', () => {
    expect(parseAttestationTypes('coffee/order, coffee/review\n coffee/order,,')).toEqual(['coffee/order', 'coffee/review']);
  });

  it('returns an empty list for blank input', () => {
    expect(parseAttestationTypes('  ')).toEqual([]);
  });
});

describe('validateProvisionForm', () => {
  it('accepts a minimal valid form', () => {
    expect(hasProvisionErrors(validateProvisionForm(values()))).toBe(false);
  });

  it.each(['', 'Coffee', '1coffee', 'cof fee', 'cof_fee', 'a'.repeat(40)])('refuses slug %j', (slug) => {
    expect(validateProvisionForm(values({ slug })).slug).toBeDefined();
  });

  it('accepts hyphenated slugs up to 39 chars', () => {
    expect(validateProvisionForm(values({ slug: `a${'-b'.repeat(19)}` })).slug).toBeUndefined();
  });

  it('requires a display name and caps its length', () => {
    expect(validateProvisionForm(values({ displayName: '   ' })).displayName).toBeDefined();
    expect(validateProvisionForm(values({ displayName: 'x'.repeat(MAX_DISPLAY_NAME_LENGTH + 1) })).displayName).toBeDefined();
  });

  it('caps template length but allows it to be empty', () => {
    expect(validateProvisionForm(values({ template: '' })).template).toBeUndefined();
    expect(validateProvisionForm(values({ template: 't'.repeat(201) })).template).toBeDefined();
  });

  it('accepts attestation types in the slug namespace', () => {
    expect(validateProvisionForm(values({ attestationTypes: 'coffee/order, coffee/review' })).attestationTypes).toBeUndefined();
  });

  it.each(['order', '/order', 'coffee/', 'other/order'])('refuses attestation type %j', (attestationTypes) => {
    expect(validateProvisionForm(values({ attestationTypes })).attestationTypes).toBeDefined();
  });

  it('refuses more than the maximum number of attestation types', () => {
    const many = Array.from({ length: MAX_ATTESTATION_TYPES + 1 }, (_, i) => `coffee/t${i}`).join(',');
    expect(validateProvisionForm(values({ attestationTypes: many })).attestationTypes).toBeDefined();
  });

  it('only checks the namespace prefix when the slug itself is valid', () => {
    const errors = validateProvisionForm(values({ slug: 'Bad Slug', attestationTypes: 'coffee/order' }));
    expect(errors.slug).toBeDefined();
    expect(errors.attestationTypes).toBeUndefined();
  });
});

describe('buildProvisionPayload', () => {
  it('trims fields, defaults the template and parses attestation types', () => {
    expect(buildProvisionPayload(values({ slug: ' coffee ', displayName: ' Coffee ', template: '  ', attestationTypes: 'coffee/order' }))).toEqual({
      slug: 'coffee',
      displayName: 'Coffee',
      template: DEFAULT_APP_TEMPLATE,
      attestationTypes: ['coffee/order'],
    });
  });

  it('keeps a custom template', () => {
    expect(buildProvisionPayload(values({ template: 'ima-jin/other' })).template).toBe('ima-jin/other');
  });
});

describe('isGithubRepoUrl', () => {
  it('accepts only https://github.com/ URLs', () => {
    expect(isGithubRepoUrl('https://github.com/ima-jin/coffee')).toBe(true);
  });

  it.each([
    null,
    undefined,
    '',
    'javascript:alert(1)',
    'http://github.com/ima-jin/coffee',
    'https://github.com.evil.example/x',
    'https://github.com@evil.example/x',
    'https://gitlab.com/ima-jin/coffee',
    'HTTPS://GITHUB.COM/ima-jin/coffee',
  ])('rejects %j', (url) => {
    expect(isGithubRepoUrl(url)).toBe(false);
  });
});

describe('isPendingCardExpired', () => {
  const now = Date.parse('2026-06-01T12:00:00.000Z');

  it('is true once expiresAt has passed (boundary included)', () => {
    expect(isPendingCardExpired({ expiresAt: '2026-06-01T11:59:59.000Z' }, now)).toBe(true);
    expect(isPendingCardExpired({ expiresAt: '2026-06-01T12:00:00.000Z' }, now)).toBe(true);
  });

  it('is false while expiresAt is in the future', () => {
    expect(isPendingCardExpired({ expiresAt: '2026-06-01T12:00:01.000Z' }, now)).toBe(false);
  });

  it.each([null, undefined, {}, { expiresAt: 42 }, { expiresAt: 'not-a-date' }])('never expires for detail %j', (detail) => {
    expect(isPendingCardExpired(detail as Record<string, unknown> | null | undefined, now)).toBe(false);
  });
});

describe('isLedgerNewerThanDecision', () => {
  const decided = '2026-06-01T12:00:00.000Z';

  it('accepts a row written after the decision', () => {
    expect(isLedgerNewerThanDecision('2026-06-01T12:00:01.000Z', decided)).toBe(true);
  });

  it('rejects a row written before or exactly at the decision', () => {
    expect(isLedgerNewerThanDecision('2026-05-01T00:00:00.000Z', decided)).toBe(false);
    expect(isLedgerNewerThanDecision(decided, decided)).toBe(false);
  });

  it.each([
    [undefined, decided],
    ['2026-06-01T12:00:01.000Z', undefined],
    ['2026-06-01T12:00:01.000Z', null],
    ['garbage', decided],
    ['2026-06-01T12:00:01.000Z', 'garbage'],
  ])('accepts the row when a timestamp is unusable (%j, %j)', (updatedAt, decidedAt) => {
    expect(isLedgerNewerThanDecision(updatedAt, decidedAt)).toBe(true);
  });
});
