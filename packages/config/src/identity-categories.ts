/**
 * Shared organization/place category taxonomy.
 * Values are persisted in profile metadata: keep existing spellings stable,
 * especially `café`, and extend this vocabulary rather than individual pickers.
 * This is a suggestion vocabulary, not a validator for historical custom values.
 */
export const IDENTITY_CATEGORIES = [
  'café',
  'restaurant',
  'shop',
  'venue',
  'studio',
  'bar',
  'gallery',
  'gym',
  'contractor',
  'trades',
  'professional services',
  'health',
  'education',
  'technology',
  'nonprofit',
] as const;
