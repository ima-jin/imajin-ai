import type { BrokerRejectionReason } from './types';

/**
 * Consent entry — what a subject has consented to release.
 */
export interface ConsentEntry {
  /** Fields the subject has agreed to share */
  allowedFields: string[];
  /** Release mode: attestation (default) or raw */
  mode: 'attestation' | 'raw';
  /** Reference ID for the consent grant */
  consentRef: string;
  /** Optional expiry (ISO 8601) — future use */
  expiresAt?: string;
}

/**
 * Consent lookup key.
 * Format: `${subject}|${requester}|${purpose}`
 * Use `*` as wildcard for requester or purpose.
 */
type ConsentKey = string;

/**
 * Hardcoded consent configuration — Phase 1.
 *
 * Maps { subject, requester, purpose } → consent entries.
 * Multiple entries for the same key are merged permissively (union of fields).
 * Default: reject (fail-closed).
 */
const CONSENT_DEFAULTS: Record<ConsentKey, ConsentEntry[]> = {
  // Example: alice allows bob for marketing — multiple overlapping grants (union)
  'did:imajin:alice|did:imajin:bob|marketing': [
    { allowedFields: ['name', 'email'], mode: 'attestation', consentRef: 'consent-alice-bob-001' },
    { allowedFields: ['phone', 'address'], mode: 'attestation', consentRef: 'consent-alice-bob-002' },
  ],

  // Example: alice allows anyone to request name for profile display
  'did:imajin:alice|*|profile': [
    { allowedFields: ['name', 'avatar'], mode: 'attestation', consentRef: 'consent-alice-public-001' },
  ],

  // Example: alice allows bob for raw data access on analytics
  'did:imajin:alice|did:imajin:bob|analytics': [
    { allowedFields: ['name', 'email', 'age'], mode: 'raw', consentRef: 'consent-alice-bob-raw-001' },
  ],

  // Example: carol allows anyone for event registration
  'did:imajin:carol|*|event-registration': [
    { allowedFields: ['name', 'email', 'ticketType'], mode: 'attestation', consentRef: 'consent-carol-events-001' },
  ],

  // Example: dave has no consent entries → fail-closed
};

/**
 * Build lookup keys in order of specificity (most specific first).
 */
function buildLookupKeys(subject: string, requester: string, purpose: string): ConsentKey[] {
  return [
    `${subject}|${requester}|${purpose}`,
    `${subject}|*|${purpose}`,
    `${subject}|${requester}|*`,
    `${subject}|*|*`,
  ];
}

/**
 * Look up consent configuration for a broker request.
 *
 * Composes multiple matching grants permissively:
 * - Unions their allowed field sets
 * - Returns the consentRef of the most specific match
 * - Prefers 'raw' mode if any grant allows it (most permissive)
 *
 * @returns Resolved consent or undefined if no consent found
 */
export function resolveConsent(
  subject: string,
  requester: string,
  purpose: string
): { allowedFields: string[]; mode: 'attestation' | 'raw'; consentRef: string } | undefined {
  const keys = buildLookupKeys(subject, requester, purpose);
  const unionFields = new Set<string>();
  let mode: 'attestation' | 'raw' = 'attestation';
  let primaryRef = '';

  for (const key of keys) {
    const entries = CONSENT_DEFAULTS[key];
    if (!entries || entries.length === 0) continue;

    for (const entry of entries) {
      for (const f of entry.allowedFields) {
        unionFields.add(f);
      }
      if (entry.mode === 'raw') mode = 'raw';
      if (!primaryRef) primaryRef = entry.consentRef;
    }
  }

  if (unionFields.size === 0) return undefined;

  return {
    allowedFields: Array.from(unionFields),
    mode,
    consentRef: primaryRef,
  };
}

/**
 * Determine rejection reason when no consent is found.
 * Phase 1: always 'no_consent' since we have no expiry/revocation tracking.
 */
export function getDefaultRejectionReason(): BrokerRejectionReason {
  return 'no_consent';
}
