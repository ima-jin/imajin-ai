/**
 * Shared intro-funnel attestation schema (#1885).
 *
 * Keep this module dependency-free and client-safe so every service can
 * construct and verify funnels without pulling in kernel-specific code.
 */
import type { AttestationType } from './types/attestation';
import type { GrantScope } from './grant-scopes';

/** The platform-seeded intro-funnel vocabulary, in funnel order. */
export const INTRO_FUNNEL_ATTESTATION_TYPES = [
  'intro_proposed',
  'consent_given',
  'consent_declined',
  'intro_made',
  'conversation_happened',
] as const satisfies readonly AttestationType[];

export type IntroFunnelAttestationType = typeof INTRO_FUNNEL_ATTESTATION_TYPES[number];

export function isIntroFunnelAttestationType(type: string): type is IntroFunnelAttestationType {
  return (INTRO_FUNNEL_ATTESTATION_TYPES as readonly string[]).includes(type);
}

/**
 * The grant capability that must be live from `delegator_did` to
 * `issuer_did` for a delegated intro-funnel attestation to be accepted
 * (#1895, #1897). One capability covers the whole funnel — proposing,
 * consenting, and completing an intro are all facets of the delegator's
 * single `intros:propose` grant to the matchmaking agent.
 */
export const INTRO_FUNNEL_DELEGATION_CAPABILITY: GrantScope = 'intros:propose';

/**
 * Resolve the grant capability that must cover a delegated attestation of
 * this `type`, or `null` when delegation is not a defined concept for the
 * type. `payload.delegator_did` (#1885's envelope) was purpose-built for
 * the intro-funnel vocabulary — callers MUST fail closed on `null` (reject
 * the write) rather than accept an unverifiable delegation claim.
 */
export function capabilityForDelegatedAttestationType(type: string): GrantScope | null {
  return isIntroFunnelAttestationType(type) ? INTRO_FUNNEL_DELEGATION_CAPABILITY : null;
}

/**
 * Only conversation_happened uses the existing bilateral state as an
 * evidence grade. Other funnel records are single-signer facts by design.
 */
export const EVIDENCE_GRADED_ATTESTATION_TYPES =
  ['conversation_happened'] as const satisfies readonly AttestationType[];

/**
 * Closed disclosure vocabulary. Extending this is deliberately a schema
 * change and must be accompanied by a database migration.
 */
export const DISCLOSURE_SCOPES = ['parties', 'connections', 'network', 'public'] as const;
export type DisclosureScope = typeof DISCLOSURE_SCOPES[number];
export const DEFAULT_DISCLOSURE_SCOPE: DisclosureScope = 'parties';

export function isDisclosureScope(value: string): value is DisclosureScope {
  return (DISCLOSURE_SCOPES as readonly string[]).includes(value);
}

export const EVIDENCE_GRADES = ['unilateral', 'corroborated', 'disputed'] as const;
export type EvidenceGrade = typeof EVIDENCE_GRADES[number];

/**
 * Project the existing countersign/decline state into a stable evidence
 * grade. Decline is the dispute mechanism; there is no parallel dispute flow.
 */
export function evidenceGradeForAttestationStatus(
  status: string | null | undefined,
): EvidenceGrade | null {
  switch (status) {
    case 'pending':
      return 'unilateral';
    case 'bilateral':
      return 'corroborated';
    case 'declined':
      return 'disputed';
    default:
      return null;
  }
}

/**
 * The type an event's prev_event_ref must identify. intro_made points to the
 * proposal because its two consent dependencies fan in through context_id.
 */
export function expectedPrevEventType(
  type: IntroFunnelAttestationType,
): IntroFunnelAttestationType | null {
  switch (type) {
    case 'intro_proposed':
      return null;
    case 'consent_given':
    case 'consent_declined':
    case 'intro_made':
      return 'intro_proposed';
    case 'conversation_happened':
      return 'intro_made';
  }
}

/** Minimal storage-independent shape needed to verify a funnel chain. */
export interface FunnelChainEvent {
  id: string;
  type: string;
  prevEventRef: string | null;
}

export type FunnelChainVerification =
  | { ok: true }
  | {
      ok: false;
      reason:
        | 'unknown-type'
        | 'unexpected-prev-event-ref'
        | 'missing-prev-event-ref'
        | 'missing-predecessor'
        | 'wrong-predecessor-type';
      eventId: string;
    };

/** Verify one event against the predecessor held by the caller. */
export function verifyFunnelChainLink(
  event: FunnelChainEvent,
  predecessor: FunnelChainEvent | null,
): FunnelChainVerification {
  if (!isIntroFunnelAttestationType(event.type)) {
    return { ok: false, reason: 'unknown-type', eventId: event.id };
  }

  const expectedType = expectedPrevEventType(event.type);
  if (expectedType === null) {
    return event.prevEventRef === null
      ? { ok: true }
      : { ok: false, reason: 'unexpected-prev-event-ref', eventId: event.id };
  }
  if (!event.prevEventRef) {
    return { ok: false, reason: 'missing-prev-event-ref', eventId: event.id };
  }
  if (!predecessor || predecessor.id !== event.prevEventRef) {
    return { ok: false, reason: 'missing-predecessor', eventId: event.id };
  }
  if (predecessor.type !== expectedType) {
    return { ok: false, reason: 'wrong-predecessor-type', eventId: event.id };
  }
  return { ok: true };
}

/** Verify every link in a funnel chain held by one party. */
export function verifyFunnelChain(
  events: readonly FunnelChainEvent[],
): FunnelChainVerification {
  const byId = new Map(events.map((event) => [event.id, event]));
  for (const event of events) {
    const predecessor = event.prevEventRef
      ? byId.get(event.prevEventRef) ?? null
      : null;
    const result = verifyFunnelChainLink(event, predecessor);
    if (!result.ok) return result;
  }
  return { ok: true };
}

/**
 * Two independent consent records correlate to one proposal through the
 * existing generic context fields rather than a funnel-specific FK column.
 */
export const INTRO_FUNNEL_CONTEXT_TYPE = 'intro_funnel';

export function funnelCorrelationContext(
  introProposedId: string,
): { context_id: string; context_type: typeof INTRO_FUNNEL_CONTEXT_TYPE } {
  return {
    context_id: introProposedId,
    context_type: INTRO_FUNNEL_CONTEXT_TYPE,
  };
}
