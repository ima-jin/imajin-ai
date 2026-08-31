/**
 * Unit tests for verifyDelegatedAttestation (#1895, #1897) — the RFC #1881
 * live-test finding: a self-asserted payload.delegator_did was never
 * checked against a live delegation grant, so a revoked (or never-granted)
 * agent could still mint a valid-looking "delegated" attestation.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const ISSUER = 'did:imajin:matchmaker-agent';
const DELEGATOR = 'did:imajin:ryan';
const SUBJECT = 'did:imajin:contact-x';

const h = vi.hoisted(() => ({
  introspectGrant: vi.fn(),
}));

vi.mock('@/src/lib/auth/grants', () => ({
  introspectGrant: h.introspectGrant,
}));

vi.mock('@/src/lib/http/public-origin', () => ({
  toOrigin: vi.fn(),
}));

vi.mock('@imajin/auth', () => ({
  verifyNostrSig: vi.fn(),
  isDisclosureScope: (v: string) => ['parties', 'connections', 'network', 'public'].includes(v),
  DISCLOSURE_SCOPES: ['parties', 'connections', 'network', 'public'],
  DEFAULT_DISCLOSURE_SCOPE: 'parties',
  capabilityForDelegatedAttestationType: (type: string) => (type === 'intro_proposed' ? 'intros:propose' : null),
}));

import { verifyDelegatedAttestation } from '../attestation-helpers';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('verifyDelegatedAttestation', () => {
  it('accepts a self-issued attestation with no delegator_did, without looking up any grant', async () => {
    const result = await verifyDelegatedAttestation({
      delegatorDid: null,
      issuerDid: ISSUER,
      subjectDid: SUBJECT,
      type: 'intro_proposed',
    });

    expect(result).toEqual({ ok: true, grantId: null });
    expect(h.introspectGrant).not.toHaveBeenCalled();
  });

  it('accepts when delegator_did equals issuer_did (not real delegation)', async () => {
    const result = await verifyDelegatedAttestation({
      delegatorDid: ISSUER,
      issuerDid: ISSUER,
      subjectDid: SUBJECT,
      type: 'intro_proposed',
    });

    expect(result).toEqual({ ok: true, grantId: null });
    expect(h.introspectGrant).not.toHaveBeenCalled();
  });

  it('fails closed for an attestation type with no defined delegation capability', async () => {
    const result = await verifyDelegatedAttestation({
      delegatorDid: DELEGATOR,
      issuerDid: ISSUER,
      subjectDid: SUBJECT,
      type: 'vouch.given',
    });

    expect(result).toMatchObject({ ok: false });
    expect(h.introspectGrant).not.toHaveBeenCalled();
  });

  it('rejects when the claimed delegator never granted this capability (absent grant)', async () => {
    h.introspectGrant.mockResolvedValue({
      authorized: false,
      reason: 'No active, unexpired grant covers this capability and audience',
    });

    const result = await verifyDelegatedAttestation({
      delegatorDid: DELEGATOR,
      issuerDid: ISSUER,
      subjectDid: SUBJECT,
      type: 'intro_proposed',
    });

    expect(result).toMatchObject({ ok: false });
    expect(h.introspectGrant).toHaveBeenCalledWith({
      agentDid: ISSUER,
      capability: 'intros:propose',
      targetDid: SUBJECT,
      delegatorDid: DELEGATOR,
    });
  });

  it('rejects when the delegator revoked the grant before this write (revoked grant)', async () => {
    // A revoked grant introspects identically to an absent one — fails
    // closed, no eventual-revocation window (mirrors introspectGrant's own
    // contract).
    h.introspectGrant.mockResolvedValue({
      authorized: false,
      reason: 'No active, unexpired grant covers this capability and audience',
    });

    const result = await verifyDelegatedAttestation({
      delegatorDid: DELEGATOR,
      issuerDid: ISSUER,
      subjectDid: SUBJECT,
      type: 'intro_proposed',
    });

    expect(result).toEqual({
      ok: false,
      error: `No live delegation grant from "${DELEGATOR}" to "${ISSUER}" covers "intros:propose"`,
    });
  });

  it('accepts and returns the verified grantId when a live grant covers the claimed delegator', async () => {
    h.introspectGrant.mockResolvedValue({
      authorized: true,
      grantId: 'grant_live_123',
      delegatorDid: DELEGATOR,
      agentDid: ISSUER,
    });

    const result = await verifyDelegatedAttestation({
      delegatorDid: DELEGATOR,
      issuerDid: ISSUER,
      subjectDid: SUBJECT,
      type: 'intro_proposed',
    });

    expect(result).toEqual({ ok: true, grantId: 'grant_live_123' });
  });

  it('rejects even an "authorized" introspection result that carries no grantId', async () => {
    h.introspectGrant.mockResolvedValue({ authorized: true });

    const result = await verifyDelegatedAttestation({
      delegatorDid: DELEGATOR,
      issuerDid: ISSUER,
      subjectDid: SUBJECT,
      type: 'intro_proposed',
    });

    expect(result).toMatchObject({ ok: false });
  });
});
