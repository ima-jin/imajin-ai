import { describe, it, expect } from 'vitest';
import {
  INTRO_FUNNEL_ATTESTATION_TYPES,
  DISCLOSURE_SCOPES,
  isDisclosureScope,
  isIntroFunnelAttestationType,
  evidenceGradeForAttestationStatus,
  expectedPrevEventType,
  verifyFunnelChainLink,
  verifyFunnelChain,
  funnelCorrelationContext,
  type FunnelChainEvent,
} from '../src/intro-funnel';

describe('INTRO_FUNNEL_ATTESTATION_TYPES', () => {
  it('contains exactly the five funnel types in funnel order', () => {
    expect(INTRO_FUNNEL_ATTESTATION_TYPES).toEqual([
      'intro_proposed',
      'consent_given',
      'consent_declined',
      'intro_made',
      'conversation_happened',
    ]);
  });

  it('isIntroFunnelAttestationType recognizes funnel types and rejects others', () => {
    expect(isIntroFunnelAttestationType('intro_proposed')).toBe(true);
    expect(isIntroFunnelAttestationType('vouch.given')).toBe(false);
  });
});

describe('DISCLOSURE_SCOPES', () => {
  it('is a closed four-value enum', () => {
    expect(DISCLOSURE_SCOPES).toEqual(['parties', 'connections', 'network', 'public']);
  });

  it('isDisclosureScope guards unknown values', () => {
    expect(isDisclosureScope('parties')).toBe(true);
    expect(isDisclosureScope('public')).toBe(true);
    expect(isDisclosureScope('everyone')).toBe(false);
  });
});

describe('evidenceGradeForAttestationStatus', () => {
  it('maps pending to unilateral', () => {
    expect(evidenceGradeForAttestationStatus('pending')).toBe('unilateral');
  });

  it('maps bilateral to corroborated', () => {
    expect(evidenceGradeForAttestationStatus('bilateral')).toBe('corroborated');
  });

  it('maps declined to disputed', () => {
    expect(evidenceGradeForAttestationStatus('declined')).toBe('disputed');
  });

  it('returns null for legacy/null status', () => {
    expect(evidenceGradeForAttestationStatus(null)).toBeNull();
    expect(evidenceGradeForAttestationStatus(undefined)).toBeNull();
    expect(evidenceGradeForAttestationStatus('collecting')).toBeNull();
  });
});

describe('expectedPrevEventType', () => {
  it('intro_proposed has no predecessor', () => {
    expect(expectedPrevEventType('intro_proposed')).toBeNull();
  });

  it('consent_given, consent_declined, and intro_made point back to intro_proposed', () => {
    expect(expectedPrevEventType('consent_given')).toBe('intro_proposed');
    expect(expectedPrevEventType('consent_declined')).toBe('intro_proposed');
    expect(expectedPrevEventType('intro_made')).toBe('intro_proposed');
  });

  it('conversation_happened points back to intro_made', () => {
    expect(expectedPrevEventType('conversation_happened')).toBe('intro_made');
  });
});

function ev(id: string, type: string, prevEventRef: string | null): FunnelChainEvent {
  return { id, type, prevEventRef };
}

describe('verifyFunnelChainLink', () => {
  it('accepts a genesis intro_proposed with no prev_event_ref', () => {
    expect(verifyFunnelChainLink(ev('a1', 'intro_proposed', null), null)).toEqual({ ok: true });
  });

  it('rejects an intro_proposed that claims a predecessor', () => {
    const result = verifyFunnelChainLink(ev('a1', 'intro_proposed', 'a0'), null);
    expect(result).toMatchObject({ ok: false, reason: 'unexpected-prev-event-ref' });
  });

  it('accepts consent_given whose prev_event_ref resolves to the proposal', () => {
    const proposal = ev('a1', 'intro_proposed', null);
    const consent = ev('a2', 'consent_given', 'a1');
    expect(verifyFunnelChainLink(consent, proposal)).toEqual({ ok: true });
  });

  it('rejects a missing prev_event_ref on a non-genesis event', () => {
    const result = verifyFunnelChainLink(ev('a2', 'consent_given', null), null);
    expect(result).toMatchObject({ ok: false, reason: 'missing-prev-event-ref' });
  });

  it('rejects when the referenced predecessor is absent', () => {
    const result = verifyFunnelChainLink(ev('a2', 'consent_given', 'a1'), null);
    expect(result).toMatchObject({ ok: false, reason: 'missing-predecessor' });
  });

  it('rejects when the predecessor id does not match prev_event_ref', () => {
    const wrongPredecessor = ev('other', 'intro_proposed', null);
    const result = verifyFunnelChainLink(ev('a2', 'consent_given', 'a1'), wrongPredecessor);
    expect(result).toMatchObject({ ok: false, reason: 'missing-predecessor' });
  });

  it('rejects when the predecessor is the wrong type', () => {
    const wrongType = ev('a1', 'consent_given', null);
    const result = verifyFunnelChainLink(ev('a2', 'intro_made', 'a1'), wrongType);
    expect(result).toMatchObject({ ok: false, reason: 'wrong-predecessor-type' });
  });

  it('rejects an unknown attestation type', () => {
    const result = verifyFunnelChainLink(ev('a9', 'vouch.given', null), null);
    expect(result).toMatchObject({ ok: false, reason: 'unknown-type' });
  });
});

describe('verifyFunnelChain', () => {
  it('verifies a full valid funnel: proposed -> two consents -> made -> conversation', () => {
    const events: FunnelChainEvent[] = [
      ev('proposed', 'intro_proposed', null),
      ev('consent-a', 'consent_given', 'proposed'),
      ev('consent-b', 'consent_declined', 'proposed'),
      ev('made', 'intro_made', 'proposed'),
      ev('conv', 'conversation_happened', 'made'),
    ];
    expect(verifyFunnelChain(events)).toEqual({ ok: true });
  });

  it('reports the first broken link when a predecessor is missing from the held chain', () => {
    const events: FunnelChainEvent[] = [
      ev('proposed', 'intro_proposed', null),
      ev('made', 'intro_made', 'proposed'),
      ev('conv', 'conversation_happened', 'missing-made'),
    ];
    const result = verifyFunnelChain(events);
    expect(result).toMatchObject({ ok: false, reason: 'missing-predecessor', eventId: 'conv' });
  });
});

describe('funnelCorrelationContext', () => {
  it('correlates a consent record to its proposal via context_id/context_type', () => {
    expect(funnelCorrelationContext('att_proposed_123')).toEqual({
      context_id: 'att_proposed_123',
      context_type: 'intro_funnel',
    });
  });
});
