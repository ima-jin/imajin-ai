import { createLogger } from '@imajin/logger';
import type { BrokerRejectionReason } from './types';

const log = createLogger('bus:broker:config');

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

/** Resolved consent shape returned to the broker pipeline. */
type ResolvedConsent = { allowedFields: string[]; mode: 'attestation' | 'raw'; consentRef: string };

/**
 * Compose a set of consent entries permissively (most-specific first):
 * - Unions their allowed field sets
 * - Returns the consentRef of the most specific match
 * - Prefers 'raw' mode if any entry allows it (most permissive)
 */
function composeEntries(entries: ConsentEntry[]): ResolvedConsent | undefined {
  const unionFields = new Set<string>();
  let mode: 'attestation' | 'raw' = 'attestation';
  let primaryRef = '';

  for (const entry of entries) {
    for (const f of entry.allowedFields) {
      unionFields.add(f);
    }
    if (entry.mode === 'raw') mode = 'raw';
    if (!primaryRef) primaryRef = entry.consentRef;
  }

  if (unionFields.size === 0) return undefined;

  return { allowedFields: Array.from(unionFields), mode, consentRef: primaryRef };
}

/**
 * Hardcoded fallback lookup — used only in degraded mode (DB unreachable).
 * Composes grants from {@link CONSENT_DEFAULTS} in specificity order.
 */
function resolveConsentFromDefaults(
  subject: string,
  requester: string,
  purpose: string
): ResolvedConsent | undefined {
  const keys = buildLookupKeys(subject, requester, purpose);
  const entries: ConsentEntry[] = [];
  for (const key of keys) {
    const matched = CONSENT_DEFAULTS[key];
    if (matched && matched.length > 0) entries.push(...matched);
  }
  return composeEntries(entries);
}

/**
 * DB-backed consent lookup against `kernel.consent_grants`.
 *
 * Two consent paths, composed permissively:
 *
 * 1. Per-DID grants (`granted_to` = exact DID or `*` wildcard). Ordered by
 *    specificity (exact requester + exact purpose first).
 *
 * 2. Class-based grants (`granted_to_class` = 'connections' | 'one_degree' |
 *    'strangers', `granted_to` IS NULL). The subject's connection rings are
 *    resolved via `resolveReachRings` and the requester must be a member of
 *    the appropriate ring. This enables calendar `connections` visibility (#1189)
 *    and any other reach-ring-gated consent without per-DID enumeration.
 *
 * Throws on DB error — callers (see {@link resolveConsent}) treat a throw as
 * degraded mode and fall back to {@link CONSENT_DEFAULTS}. A reachable DB with
 * no matching grants returns `undefined` (fail-closed).
 */
export async function resolveConsentFromDb(
  subject: string,
  requester: string,
  purpose: string
): Promise<ResolvedConsent | undefined> {
  const { getClient } = await import('@imajin/db');
  const sql = getClient();

  const allEntries: ConsentEntry[] = [];

  // ── Path 1: per-DID grants ────────────────────────────────────────────────
  const rows = await sql`
    SELECT allowed_fields, mode, consent_ref, granted_to, purpose
    FROM kernel.consent_grants
    WHERE subject = ${subject}
      AND granted_to IS NOT NULL
      AND (granted_to = ${requester} OR granted_to = '*')
      AND (purpose = ${purpose} OR purpose = '*')
      AND status = 'active'
      AND (expires_at IS NULL OR expires_at > now())
  `;

  if (rows.length > 0) {
    const specificity = (row: { granted_to: string; purpose: string }): number => {
      const reqWild = row.granted_to === '*';
      const purposeWild = row.purpose === '*';
      if (!reqWild && !purposeWild) return 0;
      if (reqWild && !purposeWild) return 1;
      if (!reqWild && purposeWild) return 2;
      return 3;
    };

    type GrantRow = {
      granted_to: string;
      purpose: string;
      allowed_fields: string[];
      mode: string;
      consent_ref: string;
    };

    const ordered = ([...rows] as GrantRow[]).sort((a, b) => specificity(a) - specificity(b));
    for (const row of ordered) {
      allEntries.push({
        allowedFields: row.allowed_fields ?? [],
        mode: row.mode === 'raw' ? 'raw' : 'attestation',
        consentRef: row.consent_ref,
      });
    }
  }

  // ── Path 2: grantedToClass grants (reach-ring based) ─────────────────────
  const classRows = await sql`
    SELECT allowed_fields, mode, consent_ref, granted_to_class
    FROM kernel.consent_grants
    WHERE subject = ${subject}
      AND granted_to IS NULL
      AND granted_to_class IS NOT NULL
      AND (purpose = ${purpose} OR purpose = '*')
      AND status = 'active'
      AND (expires_at IS NULL OR expires_at > now())
  `;

  if (classRows.length > 0) {
    // Resolve the subject's connection rings once per request.
    const { resolveReachRings } = await import('./match/reach');
    const subjectRings = await resolveReachRings(subject);

    type ClassGrantRow = {
      granted_to_class: string;
      allowed_fields: string[];
      mode: string;
      consent_ref: string;
    };

    for (const row of classRows as ClassGrantRow[]) {
      let admitted = false;
      switch (row.granted_to_class) {
        case 'connections':
          // subject's direct connections (favourites proxy)
          admitted = subjectRings.favouritesSet.has(requester);
          break;
        case 'one_degree':
          // subject's 1° ring (direct + 2-hop)
          admitted = subjectRings.oneDegreeSet.has(requester);
          break;
        case 'strangers':
          admitted = true;
          break;
      }
      if (admitted) {
        allEntries.push({
          allowedFields: row.allowed_fields ?? [],
          mode: row.mode === 'raw' ? 'raw' : 'attestation',
          consentRef: row.consent_ref,
        });
      }
    }
  }

  if (allEntries.length === 0) return undefined;
  return composeEntries(allEntries);
}

/**
 * Look up consent configuration for a broker request.
 *
 * DB-backed: queries `kernel.consent_grants` via {@link resolveConsentFromDb}.
 * If the DB call throws (unreachable / misconfigured), falls back to the
 * hardcoded {@link CONSENT_DEFAULTS} in degraded mode. A reachable DB with no
 * matching grants returns `undefined` (fail-closed).
 *
 * @returns Resolved consent or undefined if no consent found
 */
export async function resolveConsent(
  subject: string,
  requester: string,
  purpose: string
): Promise<ResolvedConsent | undefined> {
  try {
    return await resolveConsentFromDb(subject, requester, purpose);
  } catch (err) {
    log.warn(
      { err: String(err), subject, requester, purpose },
      'Consent DB lookup failed; degraded mode — falling back to CONSENT_DEFAULTS'
    );
    return resolveConsentFromDefaults(subject, requester, purpose);
  }
}

/**
 * Determine rejection reason when no consent is found.
 * Phase 1: always 'no_consent' since we have no expiry/revocation tracking.
 */
export function getDefaultRejectionReason(): BrokerRejectionReason {
  return 'no_consent';
}
