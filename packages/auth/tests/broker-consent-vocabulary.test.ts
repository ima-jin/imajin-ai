import { describe, it, expect } from 'vitest';
import {
  BROKER_FIELD_VOCABULARY,
  BROKER_PURPOSE_VOCABULARY,
  BROKER_RELEASE_MODES,
  BROKER_TERM_VOCABULARIES,
  brokerFieldEntry,
  brokerFieldsForPurpose,
  brokerPredicatesForField,
  isBrokerFieldAllowedForPurpose,
  isBrokerReleaseMode,
  isKnownBrokerPurpose,
  normalizeBrokerTerm,
  validateBrokerPurposeFields,
} from '@imajin/auth/broker-consent-vocabulary';

describe('BROKER_FIELD_VOCABULARY', () => {
  it('has no duplicate field names', () => {
    const seen = new Set<string>();
    const duplicates: string[] = [];
    for (const entry of BROKER_FIELD_VOCABULARY) {
      if (seen.has(entry.field)) duplicates.push(entry.field);
      seen.add(entry.field);
    }
    expect(duplicates).toEqual([]);
  });

  it('uses only known release modes and predicates', () => {
    const modes = new Set<string>(BROKER_RELEASE_MODES);
    const allowedPredicates = new Set(['eq', 'gte', 'lte', 'is_empty', 'contains', 'overlaps']);

    for (const entry of BROKER_FIELD_VOCABULARY) {
      expect(entry.allowedModes.every((mode) => modes.has(mode))).toBe(true);
      expect(entry.allowedPredicates.every((predicate) => allowedPredicates.has(predicate))).toBe(true);
    }
  });

  /**
   * `overlaps` is implemented as a disjunction of `contains` primitives (#1514),
   * so a field offering `overlaps` without `contains` would be undecomposable.
   */
  it('only offers overlaps on fields that also offer contains', () => {
    const undecomposable = BROKER_FIELD_VOCABULARY
      .filter((entry) => entry.allowedPredicates.includes('overlaps'))
      .filter((entry) => !entry.allowedPredicates.includes('contains'))
      .map((entry) => entry.field);

    expect(undecomposable).toEqual([]);
  });

  it('requires string_set fields with set predicates to name a term vocabulary', () => {
    const setPredicateFields = BROKER_FIELD_VOCABULARY.filter((entry) =>
      entry.allowedPredicates.includes('contains') || entry.allowedPredicates.includes('overlaps')
    );
    const missingVocabulary = setPredicateFields
      .filter((entry) => !entry.termVocabulary)
      .map((entry) => entry.field);

    expect(missingVocabulary).toEqual([]);
  });
});

describe('BROKER_PURPOSE_VOCABULARY', () => {
  it('has no duplicate purpose strings', () => {
    const seen = new Set<string>();
    const duplicates: string[] = [];
    for (const entry of BROKER_PURPOSE_VOCABULARY) {
      if (seen.has(entry.purpose)) duplicates.push(entry.purpose);
      seen.add(entry.purpose);
    }
    expect(duplicates).toEqual([]);
  });

  it('contains the Tripian/remote-config canonical purposes from #1444', () => {
    expect(isKnownBrokerPurpose('restaurant_reservation')).toBe(true);
    expect(isKnownBrokerPurpose('hotel_checkin')).toBe(true);
    expect(isKnownBrokerPurpose('platform_services')).toBe(true);
  });

  it('references only known broker fields', () => {
    const knownFields = new Set(BROKER_FIELD_VOCABULARY.map((entry) => entry.field));
    const unknownFields: string[] = [];

    for (const purpose of BROKER_PURPOSE_VOCABULARY) {
      for (const field of purpose.allowedFields) {
        if (!knownFields.has(field)) unknownFields.push(`${purpose.purpose}:${field}`);
      }
    }

    expect(unknownFields).toEqual([]);
  });

  it('validates purpose-specific fields without accepting fields from another purpose', () => {
    const result = validateBrokerPurposeFields('restaurant_reservation', [
      'dietary',
      'allergies',
      'ticketType',
      'unknown',
    ]);

    expect(result.valid).toEqual(['dietary', 'allergies']);
    expect(result.invalid).toEqual(['ticketType', 'unknown']);
    expect(isBrokerFieldAllowedForPurpose('event-registration', 'ticketType')).toBe(true);
    expect(isBrokerFieldAllowedForPurpose('restaurant_reservation', 'ticketType')).toBe(false);
  });

  it('returns no fields for unknown purposes', () => {
    expect(brokerFieldsForPurpose('not_registered')).toEqual([]);
    expect(validateBrokerPurposeFields('not_registered', ['name']).invalid).toEqual(['name']);
  });
});

describe('broker term vocabulary', () => {
  it('has no duplicate vocabulary ids', () => {
    const seen = new Set<string>();
    const duplicates: string[] = [];
    for (const entry of BROKER_TERM_VOCABULARIES) {
      if (seen.has(entry.id)) duplicates.push(entry.id);
      seen.add(entry.id);
    }
    expect(duplicates).toEqual([]);
  });

  it('normalizes aliases to canonical terms', () => {
    expect(normalizeBrokerTerm('allergen', 'Peanuts')).toBe('peanut');
    expect(normalizeBrokerTerm('allergen', 'arachis')).toBe('peanut');
    expect(normalizeBrokerTerm('dietary_preference', 'gluten free')).toBe('gluten_free');
    expect(normalizeBrokerTerm('accessibility_need', 'guide dog')).toBe('service_animal');
    expect(normalizeBrokerTerm('allergen', 'dragonfruit')).toBeUndefined();
  });

  it('pins allergy fields to set predicates and the allergen vocabulary', () => {
    expect(brokerFieldEntry('allergies')?.termVocabulary).toBe('allergen');
    expect(brokerPredicatesForField('allergies')).toEqual(['contains', 'overlaps', 'is_empty']);
  });
});

describe('release modes', () => {
  it('pins the raw/attestation/none mode set', () => {
    expect(BROKER_RELEASE_MODES).toEqual(['raw', 'attestation', 'none']);
    expect(isBrokerReleaseMode('raw')).toBe(true);
    expect(isBrokerReleaseMode('attestation')).toBe(true);
    expect(isBrokerReleaseMode('none')).toBe(true);
    expect(isBrokerReleaseMode('computed')).toBe(false);
  });
});
