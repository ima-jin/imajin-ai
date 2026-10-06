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
  selectQueue: [] as unknown[][],
}));

/**
 * A value that is simultaneously awaitable (a real Promise, so `await
 * db.select()...where(...)` resolves directly) and chainable via
 * `.limit()` (so `await db.select()...where(...).limit(1)` also resolves) —
 * mirrors both call shapes `validateSupersedesReference` and
 * `resolveAttestationHistory` use against the same mocked `db.select()`.
 */
function nextSelectResult(): PromiseLike<unknown[]> & { limit: () => Promise<unknown[]> } {
  const result = h.selectQueue.shift() ?? [];
  const promise = Promise.resolve(result);
  return Object.assign(promise, { limit: () => Promise.resolve(result) });
}

vi.mock('@/src/db', () => ({
  db: { select: () => ({ from: () => ({ where: () => nextSelectResult() }) }) },
  attestations: { id: 'attestations.id', supersedes: 'attestations.supersedes' },
  identities: { id: 'identities.id', publicKey: 'identities.publicKey' },
  registryApps: { id: 'registryApps.id', appDid: 'registryApps.appDid', publicKey: 'registryApps.publicKey', status: 'registryApps.status' },
}));

vi.mock('drizzle-orm', () => ({
  eq: (...args: unknown[]) => args,
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
  buildAttestDelegationCapability: (appId: string, type: string) => `attest:${appId}:${type}`,
}));

import {
  verifyDelegatedAttestation,
  resolveEnvelopeFields,
  checkSupersessionEligibility,
  validateSupersedesReference,
  isOneSidedAttestation,
  checkOneSidedSupersession,
  resolveAttestationHistory,
  resolveIssuerCredentials,
} from '../attestation-helpers';

beforeEach(() => {
  vi.clearAllMocks();
  h.selectQueue = [];
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

// #2394 — a registered app's own attestation type is delegatable via its
// namespaced attest:<appId>:<type> capability, resolved from issuerAppId.
describe('verifyDelegatedAttestation — app-delegated attestations (#2394)', () => {
  it('builds attest:<appId>:<type> when the type has no funnel capability but issuerAppId is supplied', async () => {
    h.introspectGrant.mockResolvedValue({ authorized: true, grantId: 'grant_app_1', delegatorDid: DELEGATOR, agentDid: ISSUER });

    const result = await verifyDelegatedAttestation({
      delegatorDid: DELEGATOR,
      issuerDid: ISSUER,
      subjectDid: SUBJECT,
      type: 'survey_response',
      issuerAppId: 'app_dykil123',
    });

    expect(result).toEqual({ ok: true, grantId: 'grant_app_1' });
    expect(h.introspectGrant).toHaveBeenCalledWith({
      agentDid: ISSUER,
      capability: 'attest:app_dykil123:survey_response',
      targetDid: SUBJECT,
      delegatorDid: DELEGATOR,
    });
  });

  it('prefers the platform funnel capability over building an attest: capability, even when issuerAppId is present', async () => {
    h.introspectGrant.mockResolvedValue({ authorized: true, grantId: 'grant_funnel_1', delegatorDid: DELEGATOR, agentDid: ISSUER });

    await verifyDelegatedAttestation({
      delegatorDid: DELEGATOR,
      issuerDid: ISSUER,
      subjectDid: SUBJECT,
      type: 'intro_proposed',
      issuerAppId: 'app_dykil123',
    });

    expect(h.introspectGrant).toHaveBeenCalledWith(expect.objectContaining({ capability: 'intros:propose' }));
  });

  it('still fails closed for a type with no funnel capability when issuerAppId is absent (unregistered-app issuer)', async () => {
    const result = await verifyDelegatedAttestation({
      delegatorDid: DELEGATOR,
      issuerDid: ISSUER,
      subjectDid: SUBJECT,
      type: 'survey_response',
    });

    expect(result).toMatchObject({ ok: false });
    expect(h.introspectGrant).not.toHaveBeenCalled();
  });

  it('rejects with a live grant absent for the app capability', async () => {
    h.introspectGrant.mockResolvedValue({ authorized: false, reason: 'No active, unexpired grant covers this capability and audience' });

    const result = await verifyDelegatedAttestation({
      delegatorDid: DELEGATOR,
      issuerDid: ISSUER,
      subjectDid: SUBJECT,
      type: 'survey_response',
      issuerAppId: 'app_dykil123',
    });

    expect(result).toEqual({
      ok: false,
      error: `No live delegation grant from "${DELEGATOR}" to "${ISSUER}" covers "attest:app_dykil123:survey_response"`,
    });
  });
});

describe('resolveIssuerCredentials (#2394)', () => {
  it('resolves from auth.identities when the issuer is a plain identity', async () => {
    h.selectQueue = [[{ publicKey: 'identity-public-key' }]];

    const result = await resolveIssuerCredentials(ISSUER);

    expect(result).toEqual({ publicKey: 'identity-public-key', appId: null });
  });

  it('falls back to registry.apps when the issuer is a live, active registered app', async () => {
    h.selectQueue = [[], [{ id: 'app_dykil123', publicKey: 'app-public-key', status: 'active' }]];

    const result = await resolveIssuerCredentials('did:imajin:app-dykil');

    expect(result).toEqual({ publicKey: 'app-public-key', appId: 'app_dykil123' });
  });

  it('returns null when the issuer is neither a plain identity nor an active registered app', async () => {
    h.selectQueue = [[], []];

    const result = await resolveIssuerCredentials('did:imajin:nobody');

    expect(result).toBeNull();
  });

  it('returns null when the matching registry.apps row has been revoked', async () => {
    h.selectQueue = [[], [{ id: 'app_dykil123', publicKey: 'app-public-key', status: 'revoked' }]];

    const result = await resolveIssuerCredentials('did:imajin:app-dykil');

    expect(result).toBeNull();
  });
});

// #1790 — amendment-by-supersession.
describe('resolveEnvelopeFields — payload.supersedes shape validation (#1790)', () => {
  it('defaults supersedes to null when absent', () => {
    const result = resolveEnvelopeFields({});
    expect(result).toMatchObject({ ok: true, envelope: { supersedes: null } });
  });

  it('accepts a string supersedes value', () => {
    const result = resolveEnvelopeFields({ supersedes: 'att_v1' });
    expect(result).toMatchObject({ ok: true, envelope: { supersedes: 'att_v1' } });
  });

  it('rejects a non-string supersedes value', () => {
    const result = resolveEnvelopeFields({ supersedes: 42 });
    expect(result).toEqual({ ok: false, error: 'payload.supersedes must be a string' });
  });

  it('keeps supersedes independent of prev_event_ref — both may be set without either affecting the other', () => {
    const result = resolveEnvelopeFields({ supersedes: 'att_v1', prev_event_ref: 'att_funnel_prev' });
    expect(result).toMatchObject({
      ok: true,
      envelope: { supersedes: 'att_v1', prevEventRef: 'att_funnel_prev' },
    });
  });
});

describe('checkSupersessionEligibility (#1790)', () => {
  const PROPOSER = 'did:imajin:alice';
  const OTHER = 'did:imajin:bob';

  it('accepts when the proposer is the issuer of a bilateral target', () => {
    const result = checkSupersessionEligibility(
      { issuerDid: PROPOSER, subjectDid: OTHER, attestationStatus: 'bilateral' },
      PROPOSER,
    );
    expect(result).toEqual({ ok: true });
  });

  it('accepts when the proposer is the subject of a bilateral target', () => {
    const result = checkSupersessionEligibility(
      { issuerDid: OTHER, subjectDid: PROPOSER, attestationStatus: 'bilateral' },
      PROPOSER,
    );
    expect(result).toEqual({ ok: true });
  });

  it('rejects when the proposer is neither issuer nor subject of the target', () => {
    const stranger = 'did:imajin:mallory';
    const result = checkSupersessionEligibility(
      { issuerDid: PROPOSER, subjectDid: OTHER, attestationStatus: 'bilateral' },
      stranger,
    );
    expect(result).toMatchObject({ ok: false });
    expect((result as { error: string }).error).toMatch(/party to/);
  });

  it('rejects a pending target even when the proposer is a party (supersession only applies post-bilateral)', () => {
    const result = checkSupersessionEligibility(
      { issuerDid: PROPOSER, subjectDid: OTHER, attestationStatus: 'pending' },
      PROPOSER,
    );
    expect(result).toMatchObject({ ok: false });
    expect((result as { error: string }).error).toMatch(/bilateral/);
  });

  it('rejects a declined target', () => {
    const result = checkSupersessionEligibility(
      { issuerDid: PROPOSER, subjectDid: OTHER, attestationStatus: 'declined' },
      PROPOSER,
    );
    expect(result).toMatchObject({ ok: false });
  });

  it('rejects an already-superseded target — only the operative record can be amended again', () => {
    const result = checkSupersessionEligibility(
      { issuerDid: PROPOSER, subjectDid: OTHER, attestationStatus: 'superseded' },
      PROPOSER,
    );
    expect(result).toMatchObject({ ok: false });
  });
});

describe('validateSupersedesReference (#1790)', () => {
  const V1_ID = 'att_v1';
  const PROPOSER = 'did:imajin:alice';

  it('rejects when supersedes does not reference an existing attestation', async () => {
    h.selectQueue = [[]];

    const result = await validateSupersedesReference(V1_ID, PROPOSER);

    expect(result).toEqual({ ok: false, error: `supersedes "${V1_ID}" does not reference an existing attestation` });
  });

  it('rejects when the proposer is not a party to the referenced attestation', async () => {
    h.selectQueue = [[{ id: V1_ID, issuerDid: 'did:imajin:other', subjectDid: 'did:imajin:another', attestationStatus: 'bilateral' }]];

    const result = await validateSupersedesReference(V1_ID, PROPOSER);

    expect(result).toMatchObject({ ok: false });
  });

  it('rejects when the referenced attestation is not bilateral', async () => {
    h.selectQueue = [[{ id: V1_ID, issuerDid: PROPOSER, subjectDid: 'did:imajin:other', attestationStatus: 'pending' }]];

    const result = await validateSupersedesReference(V1_ID, PROPOSER);

    expect(result).toMatchObject({ ok: false });
  });

  it('accepts a bilateral attestation the proposer is a party to', async () => {
    h.selectQueue = [[{ id: V1_ID, issuerDid: PROPOSER, subjectDid: 'did:imajin:other', attestationStatus: 'bilateral' }]];

    const result = await validateSupersedesReference(V1_ID, PROPOSER);

    expect(result).toEqual({ ok: true });
  });
});

// #2649 — same-issuer supersession of one-sided (single-signer) attestations.
describe('isOneSidedAttestation (#2649)', () => {
  it('treats a null-status attestation with no author_jws as one-sided', () => {
    expect(isOneSidedAttestation({ attestationStatus: null, authorJws: null })).toBe(true);
  });

  it('treats an attestation with a countersign status as not one-sided', () => {
    expect(isOneSidedAttestation({ attestationStatus: 'pending', authorJws: null })).toBe(false);
    expect(isOneSidedAttestation({ attestationStatus: 'bilateral', authorJws: null })).toBe(false);
  });

  it('treats an attestation carrying an author_jws as not one-sided', () => {
    expect(isOneSidedAttestation({ attestationStatus: null, authorJws: 'jws' })).toBe(false);
  });
});

describe('checkOneSidedSupersession (#2649)', () => {
  const ISSUER_DID = 'did:imajin:alice';

  it('accepts when the proposer is the issuer of an unrevoked one-sided target', () => {
    const result = checkOneSidedSupersession(
      { issuerDid: ISSUER_DID, attestationStatus: null, authorJws: null, revokedAt: null },
      ISSUER_DID,
    );
    expect(result).toEqual({ ok: true });
  });

  it('rejects when the proposer is not the issuer — being the subject is not enough', () => {
    const result = checkOneSidedSupersession(
      { issuerDid: 'did:imajin:bob', attestationStatus: null, authorJws: null, revokedAt: null },
      ISSUER_DID,
    );
    expect(result).toMatchObject({ ok: false });
    expect((result as { error: string }).error).toMatch(/issued by/);
  });

  it('rejects a revoked target', () => {
    const result = checkOneSidedSupersession(
      { issuerDid: ISSUER_DID, attestationStatus: null, authorJws: null, revokedAt: new Date() },
      ISSUER_DID,
    );
    expect(result).toMatchObject({ ok: false });
    expect((result as { error: string }).error).toMatch(/revoked/);
  });
});

describe('validateSupersedesReference — one-sided targets (#2649)', () => {
  const V1_ID = 'att_v1';
  const PROPOSER = 'did:imajin:alice';
  const oneSidedRow = (overrides: Record<string, unknown> = {}) => ({
    id: V1_ID,
    issuerDid: PROPOSER,
    subjectDid: 'did:imajin:other',
    attestationStatus: null,
    authorJws: null,
    revokedAt: null,
    ...overrides,
  });

  it('accepts a same-issuer one-sided target and flags it oneSided when allowOneSided is set', async () => {
    h.selectQueue = [[oneSidedRow()]];

    const result = await validateSupersedesReference(V1_ID, PROPOSER, { allowOneSided: true });

    expect(result).toEqual({ ok: true, oneSided: true });
  });

  it('rejects a one-sided target issued by someone else', async () => {
    h.selectQueue = [[oneSidedRow({ issuerDid: 'did:imajin:other' })]];

    const result = await validateSupersedesReference(V1_ID, PROPOSER, { allowOneSided: true });

    expect(result).toMatchObject({ ok: false });
  });

  it('rejects a revoked one-sided target', async () => {
    h.selectQueue = [[oneSidedRow({ revokedAt: new Date() })]];

    const result = await validateSupersedesReference(V1_ID, PROPOSER, { allowOneSided: true });

    expect(result).toMatchObject({ ok: false });
  });

  it('keeps one-sided targets rejected (bilateral-only) when allowOneSided is not set', async () => {
    h.selectQueue = [[oneSidedRow()]];

    const result = await validateSupersedesReference(V1_ID, PROPOSER);

    expect(result).toMatchObject({ ok: false });
    expect((result as { error: string }).error).toMatch(/bilateral/);
  });

  it('still routes a bilateral target through the bilateral check when allowOneSided is set', async () => {
    h.selectQueue = [[oneSidedRow({ attestationStatus: 'bilateral' })]];

    const result = await validateSupersedesReference(V1_ID, PROPOSER, { allowOneSided: true });

    expect(result).toEqual({ ok: true });
  });
});

describe('resolveAttestationHistory (#1790)', () => {
  it('returns null when the given id does not exist', async () => {
    h.selectQueue = [[]];

    const result = await resolveAttestationHistory('att_missing');

    expect(result).toBeNull();
  });

  it('walks backward to the root and forward through the chain, root first', async () => {
    const v1 = { id: 'att_v1', attestationStatus: 'bilateral', supersedes: null };
    const v2 = { id: 'att_v2', attestationStatus: 'superseded', supersedes: 'att_v1' };
    const v3 = { id: 'att_v3', attestationStatus: 'bilateral', supersedes: 'att_v2' };
    // Queried by the root's id: 1 start lookup (no backward hops, v1 has no
    // predecessor) + 3 forward-walk successor lookups (v1->v2, v2->v3, v3->none).
    h.selectQueue = [[v1], [v2], [v3], []];

    const result = await resolveAttestationHistory('att_v1');

    expect(result?.chain.map((link) => link.id)).toEqual(['att_v1', 'att_v2', 'att_v3']);
    expect(result?.openDisputes).toEqual([]);
  });

  it('surfaces a still-pending amendment as an open dispute against the chain\'s current end', async () => {
    const v1 = { id: 'att_v1', attestationStatus: 'bilateral', supersedes: null };
    const pendingAmendment = { id: 'att_v2_proposed', attestationStatus: 'pending', supersedes: 'att_v1' };
    // 1 start lookup + 1 forward-walk successor lookup (finds only the
    // still-pending proposal, no winner yet).
    h.selectQueue = [[v1], [pendingAmendment]];

    const result = await resolveAttestationHistory('att_v1');

    expect(result?.chain.map((link) => link.id)).toEqual(['att_v1']);
    expect(result?.openDisputes.map((link) => link.id)).toEqual(['att_v2_proposed']);
  });
});
