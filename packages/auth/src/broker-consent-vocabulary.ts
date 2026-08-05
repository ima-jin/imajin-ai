/**
 * Canonical broker consent vocabulary (#1444).
 *
 * This is the pinned artifact both broker-side code and counterparties can use
 * for purpose strings, field names, release modes, predicate names, and the
 * first registry-bound term sets used by computed attestations (#1511).
 *
 * IMPORTANT: keep this module dependency-free and client-safe. It is intended
 * to be imported by remote config tooling without pulling server-only auth code.
 */

// ── Release modes ────────────────────────────────────────────────────────────

/** Release modes a consent config may declare. `none` is an explicit deny. */
export const BROKER_RELEASE_MODES = ['raw', 'attestation', 'none'] as const;

export type BrokerReleaseMode = typeof BROKER_RELEASE_MODES[number];

// ── Predicate vocabulary ─────────────────────────────────────────────────────

/** Fixed predicate vocabulary for v1 computed attestations. */
export const BROKER_PREDICATE_NAMES = [
  'eq',
  'gte',
  'lte',
  'is_empty',
  'contains',
  'overlaps',
] as const;

export type BrokerPredicateName = typeof BROKER_PREDICATE_NAMES[number];

export type BrokerFieldValueType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'string_set'
  | 'iso_datetime'
  | 'object';

export type BrokerTermVocabularyId = 'allergen' | 'dietary_preference' | 'accessibility_need';

export interface BrokerTermEntry {
  /** Canonical term. This is the only string persisted in predicate config. */
  term: string;
  label: string;
  /** Accepted inbound aliases; normalized to `term` before predicate evaluation. */
  aliases?: readonly string[];
}

export interface BrokerTermVocabulary {
  id: BrokerTermVocabularyId;
  description: string;
  terms: readonly BrokerTermEntry[];
}

/** Registry-backed term sets. Add terms here before using them in remote config. */
export const BROKER_TERM_VOCABULARIES = [
  {
    id: 'allergen',
    description: 'Canonical food-allergen terms for set predicates such as contains/overlaps.',
    terms: [
      { term: 'peanut', label: 'Peanut', aliases: ['peanuts', 'arachis'] },
      { term: 'tree_nut', label: 'Tree nut', aliases: ['tree nut', 'tree nuts', 'nuts'] },
      { term: 'shellfish', label: 'Shellfish', aliases: ['crustacean', 'crustaceans'] },
      { term: 'fish', label: 'Fish' },
      { term: 'egg', label: 'Egg', aliases: ['eggs'] },
      { term: 'milk', label: 'Milk', aliases: ['dairy'] },
      { term: 'soy', label: 'Soy', aliases: ['soya'] },
      { term: 'wheat', label: 'Wheat', aliases: ['gluten'] },
      { term: 'sesame', label: 'Sesame' },
    ],
  },
  {
    id: 'dietary_preference',
    description: 'Canonical dietary preference terms used by restaurant and hospitality config.',
    terms: [
      { term: 'vegan', label: 'Vegan' },
      { term: 'vegetarian', label: 'Vegetarian' },
      { term: 'pescatarian', label: 'Pescatarian' },
      { term: 'gluten_free', label: 'Gluten-free', aliases: ['gluten free', 'gf'] },
      { term: 'dairy_free', label: 'Dairy-free', aliases: ['dairy free'] },
      { term: 'kosher', label: 'Kosher' },
      { term: 'halal', label: 'Halal' },
    ],
  },
  {
    id: 'accessibility_need',
    description: 'Canonical accessibility need terms for hospitality/service accommodations.',
    terms: [
      { term: 'wheelchair_access', label: 'Wheelchair access', aliases: ['wheelchair'] },
      { term: 'step_free_access', label: 'Step-free access', aliases: ['step free'] },
      { term: 'service_animal', label: 'Service animal', aliases: ['guide dog'] },
      { term: 'hearing_access', label: 'Hearing access', aliases: ['hearing assistance'] },
      { term: 'vision_access', label: 'Vision access', aliases: ['visual assistance'] },
    ],
  },
] as const satisfies readonly BrokerTermVocabulary[];

// ── Field vocabulary ─────────────────────────────────────────────────────────

export interface BrokerFieldVocabularyEntry {
  /** Canonical field name used in broker request/consent config. */
  field: string;
  label: string;
  description: string;
  valueType: BrokerFieldValueType;
  allowedPredicates: readonly BrokerPredicateName[];
  /** Modes remote configs may choose for this field. */
  allowedModes: readonly BrokerReleaseMode[];
  /** Required when a string_set field participates in set predicates. */
  termVocabulary?: BrokerTermVocabularyId;
}

export const BROKER_FIELD_VOCABULARY = [
  {
    field: 'name',
    label: 'Preferred name',
    description: 'Display or preferred name for a person or party.',
    valueType: 'string',
    allowedPredicates: ['eq', 'is_empty'],
    allowedModes: ['raw', 'attestation', 'none'],
  },
  {
    field: 'displayName',
    label: 'Display name',
    description: 'Public profile display name.',
    valueType: 'string',
    allowedPredicates: ['eq', 'is_empty'],
    allowedModes: ['raw', 'attestation', 'none'],
  },
  {
    field: 'avatar',
    label: 'Avatar',
    description: 'Public avatar URL or media reference.',
    valueType: 'string',
    allowedPredicates: ['is_empty'],
    allowedModes: ['raw', 'none'],
  },
  {
    field: 'bio',
    label: 'Bio',
    description: 'Public profile biography or short description.',
    valueType: 'string',
    allowedPredicates: ['is_empty'],
    allowedModes: ['raw', 'attestation', 'none'],
  },
  {
    field: 'email',
    label: 'Email address',
    description: 'Contact email address.',
    valueType: 'string',
    allowedPredicates: ['eq', 'is_empty'],
    allowedModes: ['raw', 'attestation', 'none'],
  },
  {
    field: 'phone',
    label: 'Phone number',
    description: 'Contact phone number.',
    valueType: 'string',
    allowedPredicates: ['eq', 'is_empty'],
    allowedModes: ['raw', 'attestation', 'none'],
  },
  {
    field: 'address',
    label: 'Address',
    description: 'Mailing or service address.',
    valueType: 'string',
    allowedPredicates: ['is_empty'],
    allowedModes: ['raw', 'attestation', 'none'],
  },
  {
    field: 'age',
    label: 'Age',
    description: 'Age in years.',
    valueType: 'number',
    allowedPredicates: ['eq', 'gte', 'lte'],
    allowedModes: ['attestation', 'raw', 'none'],
  },
  {
    field: 'legal_name',
    label: 'Legal name',
    description: 'Legal name for regulated hospitality check-in flows.',
    valueType: 'string',
    allowedPredicates: ['eq', 'is_empty'],
    allowedModes: ['raw', 'attestation', 'none'],
  },
  {
    field: 'dietary',
    label: 'Dietary preferences',
    description: 'Dietary preference set declared by the traveler/subject.',
    valueType: 'string_set',
    termVocabulary: 'dietary_preference',
    allowedPredicates: ['contains', 'overlaps', 'is_empty'],
    allowedModes: ['raw', 'attestation', 'none'],
  },
  {
    field: 'allergies',
    label: 'Allergies',
    description: 'Allergen set declared by the traveler/subject.',
    valueType: 'string_set',
    termVocabulary: 'allergen',
    allowedPredicates: ['contains', 'overlaps', 'is_empty'],
    allowedModes: ['attestation', 'raw', 'none'],
  },
  {
    field: 'accessibility_needs',
    label: 'Accessibility needs',
    description: 'Accessibility accommodation set.',
    valueType: 'string_set',
    termVocabulary: 'accessibility_need',
    allowedPredicates: ['contains', 'overlaps', 'is_empty'],
    allowedModes: ['raw', 'attestation', 'none'],
  },
  {
    field: 'budget',
    label: 'Budget',
    description: 'Budget or spending threshold for a reservation or service.',
    valueType: 'number',
    allowedPredicates: ['eq', 'gte', 'lte'],
    allowedModes: ['attestation', 'raw', 'none'],
  },
  {
    field: 'party_size',
    label: 'Party size',
    description: 'Number of guests in a reservation.',
    valueType: 'number',
    allowedPredicates: ['eq', 'gte', 'lte'],
    allowedModes: ['raw', 'attestation', 'none'],
  },
  {
    field: 'reservation_time',
    label: 'Reservation time',
    description: 'Requested reservation date/time.',
    valueType: 'iso_datetime',
    allowedPredicates: ['eq', 'gte', 'lte', 'is_empty'],
    allowedModes: ['raw', 'attestation', 'none'],
  },
  {
    field: 'arrival_time',
    label: 'Arrival time',
    description: 'Expected arrival/check-in date/time.',
    valueType: 'iso_datetime',
    allowedPredicates: ['eq', 'gte', 'lte', 'is_empty'],
    allowedModes: ['raw', 'attestation', 'none'],
  },
  {
    field: 'ticketType',
    label: 'Ticket type',
    description: 'Event registration ticket class.',
    valueType: 'string',
    allowedPredicates: ['eq', 'is_empty'],
    allowedModes: ['raw', 'attestation', 'none'],
  },
  {
    field: 'locale',
    label: 'Locale',
    description: 'Preferred locale/language tag.',
    valueType: 'string',
    allowedPredicates: ['eq', 'is_empty'],
    allowedModes: ['raw', 'attestation', 'none'],
  },
  {
    field: 'timezone',
    label: 'Timezone',
    description: 'Preferred IANA timezone.',
    valueType: 'string',
    allowedPredicates: ['eq', 'is_empty'],
    allowedModes: ['raw', 'attestation', 'none'],
  },
] as const satisfies readonly BrokerFieldVocabularyEntry[];

export type BrokerFieldName = typeof BROKER_FIELD_VOCABULARY[number]['field'];

// ── Purpose vocabulary ───────────────────────────────────────────────────────

export interface BrokerPurposeVocabularyEntry {
  /** Canonical purpose string used in consent grants and broker requests. */
  purpose: string;
  label: string;
  description: string;
  allowedFields: readonly BrokerFieldName[];
  /** `canonical` for new remote configs; `compatibility` preserves shipped flows. */
  status: 'canonical' | 'compatibility';
}

export const BROKER_PURPOSE_VOCABULARY = [
  {
    purpose: 'restaurant_reservation',
    label: 'Restaurant reservation',
    description: 'Restaurant or travel-dining flow that may need preferences, allergy gates, contact, and reservation logistics.',
    allowedFields: ['name', 'email', 'phone', 'dietary', 'allergies', 'accessibility_needs', 'budget', 'party_size', 'reservation_time'],
    status: 'canonical',
  },
  {
    purpose: 'hotel_checkin',
    label: 'Hotel check-in',
    description: 'Hospitality check-in flow that may need identity/contact details and accommodation preferences.',
    allowedFields: ['name', 'legal_name', 'email', 'phone', 'arrival_time', 'accessibility_needs', 'dietary', 'allergies'],
    status: 'canonical',
  },
  {
    purpose: 'platform_services',
    label: 'Platform services',
    description: 'Core platform service delivery, profile display, notifications, and account support.',
    allowedFields: ['name', 'displayName', 'avatar', 'bio', 'email', 'phone', 'locale', 'timezone'],
    status: 'canonical',
  },
  {
    purpose: 'profile.field',
    label: 'Profile field visibility',
    description: 'Existing profile metadata broker gate used by the kernel profile API.',
    allowedFields: ['name', 'displayName', 'avatar', 'email', 'phone', 'locale', 'timezone'],
    status: 'compatibility',
  },
  {
    purpose: 'contact.disclosure',
    label: 'Contact disclosure',
    description: 'Existing broker gate for releasing vault-backed contact fields.',
    allowedFields: ['email', 'phone'],
    status: 'compatibility',
  },
  {
    purpose: 'marketing',
    label: 'Marketing',
    description: 'Legacy sample consent purpose kept for broker default compatibility.',
    allowedFields: ['name', 'email', 'phone', 'address'],
    status: 'compatibility',
  },
  {
    purpose: 'profile',
    label: 'Profile display',
    description: 'Legacy sample public-profile purpose kept for broker default compatibility.',
    allowedFields: ['name', 'avatar'],
    status: 'compatibility',
  },
  {
    purpose: 'analytics',
    label: 'Analytics',
    description: 'Legacy sample analytics purpose kept for broker default compatibility.',
    allowedFields: ['name', 'email', 'age'],
    status: 'compatibility',
  },
  {
    purpose: 'event-registration',
    label: 'Event registration',
    description: 'Legacy event-registration purpose kept for broker default compatibility.',
    allowedFields: ['name', 'email', 'ticketType'],
    status: 'compatibility',
  },
] as const satisfies readonly BrokerPurposeVocabularyEntry[];

export type BrokerPurpose = typeof BROKER_PURPOSE_VOCABULARY[number]['purpose'];

// ── Runtime lookups ──────────────────────────────────────────────────────────

const FIELD_ENTRIES: readonly BrokerFieldVocabularyEntry[] = BROKER_FIELD_VOCABULARY;
const PURPOSE_ENTRIES: readonly BrokerPurposeVocabularyEntry[] = BROKER_PURPOSE_VOCABULARY;
const TERM_VOCABULARIES: readonly BrokerTermVocabulary[] = BROKER_TERM_VOCABULARIES;

const BY_FIELD = new Map<string, BrokerFieldVocabularyEntry>(FIELD_ENTRIES.map((entry) => [entry.field, entry]));
const BY_PURPOSE = new Map<string, BrokerPurposeVocabularyEntry>(PURPOSE_ENTRIES.map((entry) => [entry.purpose, entry]));
const BY_TERM_VOCABULARY = new Map<string, BrokerTermVocabulary>(TERM_VOCABULARIES.map((entry) => [entry.id, entry]));

/** Look up a field entry, or undefined for an unknown field name. */
export function brokerFieldEntry(field: string): BrokerFieldVocabularyEntry | undefined {
  return BY_FIELD.get(field);
}

/** Look up a purpose entry, or undefined for an unknown purpose string. */
export function brokerPurposeEntry(purpose: string): BrokerPurposeVocabularyEntry | undefined {
  return BY_PURPOSE.get(purpose);
}

/** Look up a term vocabulary, or undefined for an unknown vocabulary id. */
export function brokerTermVocabulary(id: string): BrokerTermVocabulary | undefined {
  return BY_TERM_VOCABULARY.get(id);
}

export function isKnownBrokerField(field: string): field is BrokerFieldName {
  return BY_FIELD.has(field);
}

export function isKnownBrokerPurpose(purpose: string): purpose is BrokerPurpose {
  return BY_PURPOSE.has(purpose);
}

export function isBrokerReleaseMode(mode: string): mode is BrokerReleaseMode {
  return (BROKER_RELEASE_MODES as readonly string[]).includes(mode);
}

export function isBrokerPredicateName(predicate: string): predicate is BrokerPredicateName {
  return (BROKER_PREDICATE_NAMES as readonly string[]).includes(predicate);
}

/** All canonical/compatibility purposes in registry order. */
export function allBrokerPurposes(): readonly BrokerPurpose[] {
  return PURPOSE_ENTRIES.map((entry) => entry.purpose as BrokerPurpose);
}

/** All canonical field names in registry order. */
export function allBrokerFields(): readonly BrokerFieldName[] {
  return FIELD_ENTRIES.map((entry) => entry.field as BrokerFieldName);
}

/** Fields permitted for a purpose, or [] for an unknown purpose. */
export function brokerFieldsForPurpose(purpose: string): readonly BrokerFieldName[] {
  return brokerPurposeEntry(purpose)?.allowedFields ?? [];
}

/** True iff a purpose is known and may request the given field. */
export function isBrokerFieldAllowedForPurpose(purpose: string, field: string): field is BrokerFieldName {
  return brokerFieldsForPurpose(purpose).includes(field as BrokerFieldName);
}

/** Predicates permitted for a field, or [] for an unknown field. */
export function brokerPredicatesForField(field: string): readonly BrokerPredicateName[] {
  return brokerFieldEntry(field)?.allowedPredicates ?? [];
}

/** Validate a set of fields for a known purpose, preserving input order. */
export function validateBrokerPurposeFields(
  purpose: string,
  fields: readonly string[]
): { valid: BrokerFieldName[]; invalid: string[] } {
  const allowedFields = new Set<string>(brokerFieldsForPurpose(purpose));
  const valid: BrokerFieldName[] = [];
  const invalid: string[] = [];

  for (const field of fields) {
    if (allowedFields.has(field) && isKnownBrokerField(field)) {
      valid.push(field);
    } else {
      invalid.push(field);
    }
  }

  return { valid, invalid };
}

function normalizeTermValue(value: string): string {
  return value.trim().toLowerCase().replaceAll('-', '_').replaceAll(' ', '_');
}

/**
 * Normalize an inbound set term to the canonical registry term. Returns
 * undefined if the term is not present in the requested vocabulary.
 */
export function normalizeBrokerTerm(
  vocabulary: BrokerTermVocabularyId,
  value: string
): string | undefined {
  const termVocabulary = brokerTermVocabulary(vocabulary);
  if (!termVocabulary) return undefined;

  const normalizedValue = normalizeTermValue(value);
  for (const entry of termVocabulary.terms) {
    const accepted = [entry.term, ...(entry.aliases ?? [])].map(normalizeTermValue);
    if (accepted.includes(normalizedValue)) return entry.term;
  }

  return undefined;
}
