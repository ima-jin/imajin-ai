/**
 * Tests for POST /auth/api/attestations — the `attestation.created` bus emit (#1820).
 *
 * The route already published `attestation.created`; what's pinned here is the
 * enriched payload: issuerDid/contextId/contextType pass through, `originUrl` is
 * derived from the request's `Origin` header when present, and `pendingSignature`
 * reflects whether the caller supplied an `author_jws` (the bilateral
 * counter-signature flow the `attestation-notify` reactor gates on).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const ISSUER = 'did:imajin:alice';
const SUBJECT = 'did:imajin:bob';

const DELEGATOR = 'did:imajin:ryan';

const h = vi.hoisted(() => ({
  mockReturning: vi.fn(),
  mockSelectLimit: vi.fn(),
  mockPublish: vi.fn().mockResolvedValue(undefined),
  verifySessionToken: vi.fn(),
  mockVerifySessionAppTokenLocal: vi.fn(),
  mockResolveActiveAppByAudience: vi.fn(),
  mockInsertValues: vi.fn(),
  mockIntrospectGrant: vi.fn(),
}));

vi.mock('@/src/db', () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: h.mockSelectLimit }) }) }),
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        h.mockInsertValues(values);
        return { returning: h.mockReturning };
      },
    }),
  },
  identities: {},
  registryApps: {},
  attestations: {},
  tokens: {},
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  isNull: vi.fn(),
  gt: vi.fn(),
  desc: vi.fn(),
}));

vi.mock('@/src/lib/auth/jwt', () => ({
  verifySessionToken: h.verifySessionToken,
  verifySessionAppTokenLocal: h.mockVerifySessionAppTokenLocal,
  getSessionCookieOptions: () => ({ name: 'session' }),
}));

vi.mock('@/src/lib/kernel/app-registry', () => ({
  resolveActiveAppByAudience: h.mockResolveActiveAppByAudience,
}));

vi.mock('@/src/lib/auth/grants', () => ({
  introspectGrant: h.mockIntrospectGrant,
}));

vi.mock('@imajin/config', () => ({ corsHeaders: () => ({}) }));

vi.mock('@imajin/auth', () => ({
  canonicalize: (obj: unknown) => JSON.stringify(obj),
  crypto: { verifySync: () => true },
  ATTESTATION_TYPES: ['delivery.receipt', 'intro_proposed', 'survey_response'],
  verifyNostrSig: vi.fn(),
  DISCLOSURE_SCOPES: ['parties', 'connections', 'network', 'public'],
  DEFAULT_DISCLOSURE_SCOPE: 'parties',
  isDisclosureScope: (v: string) => ['parties', 'connections', 'network', 'public'].includes(v),
  evidenceGradeForAttestationStatus: vi.fn(),
  capabilityForDelegatedAttestationType: (type: string) => (type === 'intro_proposed' ? 'intros:propose' : null),
  buildAttestDelegationCapability: (appId: string, type: string) => `attest:${appId}:${type}`,
}));

vi.mock('@imajin/cid', () => ({ computeCid: vi.fn().mockResolvedValue('bafy-test') }));

vi.mock('@imajin/logger', () => ({
  withLogger: (_service: string, handler: (req: unknown, ctx: unknown) => Promise<Response>) =>
    (req: unknown) => handler(req, { log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() } }),
}));

vi.mock('@imajin/bus', () => ({ publish: h.mockPublish }));

vi.mock('@/src/lib/auth/attestation-type-registry', () => ({
  isRegisteredAttestationType: vi.fn().mockResolvedValue(false),
}));

import { POST } from '../route';

function makeReq(body: unknown, opts: { origin?: string } = {}): NextRequest {
  const headers = new Headers();
  if (opts.origin) headers.set('origin', opts.origin);
  return {
    cookies: { get: () => ({ value: 'session-token' }) },
    headers,
    json: async () => body,
  } as unknown as NextRequest;
}

/** A request with no session cookie, authenticated only via `Authorization: Bearer <token>` (#2394). */
function makeBearerReq(body: unknown, token: string): NextRequest {
  const headers = new Headers();
  headers.set('authorization', `Bearer ${token}`);
  return {
    cookies: { get: () => undefined },
    headers,
    json: async () => body,
  } as unknown as NextRequest;
}

function baseBody(overrides: Record<string, unknown> = {}) {
  return {
    issuer_did: ISSUER,
    subject_did: SUBJECT,
    type: 'delivery.receipt',
    signature: 'sig',
    context_id: 'ctx_1',
    context_type: 'delivery',
    ...overrides,
  };
}

function publishedPayload(): Record<string, unknown> {
  return h.mockPublish.mock.calls[0][1].payload as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.verifySessionToken.mockResolvedValue({ sub: ISSUER });
  h.mockVerifySessionAppTokenLocal.mockResolvedValue(null);
  h.mockResolveActiveAppByAudience.mockResolvedValue(null);
  h.mockSelectLimit.mockResolvedValue([{ publicKey: 'fake-public-key' }]);
  h.mockReturning.mockResolvedValue([{ id: 'att_test_123' }]);
  h.mockPublish.mockResolvedValue(undefined);
  h.mockIntrospectGrant.mockResolvedValue({ authorized: false, reason: 'No active, unexpired grant covers this capability and audience' });
});

describe('attestation.created payload', () => {
  it('carries issuerDid, subjectDid, contextId, and contextType', async () => {
    const res = await POST(makeReq(baseBody()));

    expect(res.status).toBe(201);
    expect(h.mockPublish).toHaveBeenCalledTimes(1);
    expect(h.mockPublish.mock.calls[0][0]).toBe('attestation.created');
    expect(publishedPayload()).toMatchObject({
      attestationId: 'att_test_123',
      type: 'delivery.receipt',
      issuerDid: ISSUER,
      subjectDid: SUBJECT,
      contextId: 'ctx_1',
      contextType: 'delivery',
    });
  });

  it('derives originUrl from the request Origin header when present', async () => {
    await POST(makeReq(baseBody(), { origin: 'https://xprize.example.com' }));

    expect(publishedPayload().originUrl).toBe('https://xprize.example.com');
  });

  it('omits originUrl when the request has no Origin header', async () => {
    await POST(makeReq(baseBody()));

    expect(publishedPayload().originUrl).toBeUndefined();
  });

  it('sets pendingSignature true when the caller supplies author_jws', async () => {
    await POST(makeReq(baseBody({ author_jws: 'node-signature-token' })));

    expect(publishedPayload().pendingSignature).toBe(true);
  });

  it('sets pendingSignature false for a legacy attestation with no author_jws', async () => {
    await POST(makeReq(baseBody()));

    expect(publishedPayload().pendingSignature).toBe(false);
  });

  it('defaults contextId/contextType to null when omitted', async () => {
    await POST(makeReq(baseBody({ context_id: undefined, context_type: undefined })));

    expect(publishedPayload()).toMatchObject({ contextId: null, contextType: null });
  });
});

// #1895 / #1897 — RFC #1881 revocation finding: a self-asserted
// payload.delegator_did must be backed by a live grant, not merely shaped
// like a string.
describe('delegated attestations (#1895, #1897)', () => {
  function delegatedBody(overrides: Record<string, unknown> = {}) {
    return baseBody({
      type: 'intro_proposed',
      payload: { delegator_did: DELEGATOR },
      ...overrides,
    });
  }

  it('rejects with 403 when no grant exists at all from the claimed delegator (absent grant)', async () => {
    h.mockIntrospectGrant.mockResolvedValue({ authorized: false, reason: 'No active, unexpired grant covers this capability and audience' });

    const res = await POST(makeReq(delegatedBody()));

    expect(res.status).toBe(403);
    expect(h.mockPublish).not.toHaveBeenCalled();
    expect(h.mockIntrospectGrant).toHaveBeenCalledWith({
      agentDid: ISSUER,
      capability: 'intros:propose',
      targetDid: SUBJECT,
      delegatorDid: DELEGATOR,
    });
  });

  it('rejects with 403 when the delegator revoked the grant before this write (revoked grant)', async () => {
    // A revoked grant introspects identically to an absent one — fails
    // closed, no eventual-revocation window.
    h.mockIntrospectGrant.mockResolvedValue({ authorized: false, reason: 'No active, unexpired grant covers this capability and audience' });

    const res = await POST(makeReq(delegatedBody()));

    expect(res.status).toBe(403);
    expect(h.mockInsertValues).not.toHaveBeenCalled();
  });

  it('accepts and records the verified grantId when a live grant covers the claimed delegator', async () => {
    h.mockIntrospectGrant.mockResolvedValue({ authorized: true, grantId: 'grant_live_123', delegatorDid: DELEGATOR, agentDid: ISSUER });

    const res = await POST(makeReq(delegatedBody()));

    expect(res.status).toBe(201);
    expect(h.mockInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({ delegatorDid: DELEGATOR, delegationGrantId: 'grant_live_123' }),
    );
  });

  it('never calls introspectGrant for a self-issued attestation (no delegator_did)', async () => {
    await POST(makeReq(baseBody()));

    expect(h.mockIntrospectGrant).not.toHaveBeenCalled();
  });

  it('never calls introspectGrant when delegator_did equals issuer_did', async () => {
    await POST(makeReq(delegatedBody({ payload: { delegator_did: ISSUER } })));

    expect(h.mockIntrospectGrant).not.toHaveBeenCalled();
  });

  it('rejects with 403 when the attestation type has no defined delegation capability', async () => {
    const res = await POST(makeReq(baseBody({ type: 'delivery.receipt', payload: { delegator_did: DELEGATOR } })));

    expect(res.status).toBe(403);
    expect(h.mockIntrospectGrant).not.toHaveBeenCalled();
  });
});

// #1790 — amendment-by-supersession: creation-time party + bilateral validation.
describe('amendment-by-supersession (#1790)', () => {
  const V1_ID = 'att_v1_bilateral';

  function supersedingBody(overrides: Record<string, unknown> = {}) {
    return baseBody({ payload: { supersedes: V1_ID }, ...overrides });
  }

  it('rejects with 400 when supersedes does not reference an existing attestation', async () => {
    h.mockSelectLimit.mockResolvedValueOnce([]); // supersedes lookup finds nothing

    const res = await POST(makeReq(supersedingBody()));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/does not reference an existing attestation/);
    expect(h.mockInsertValues).not.toHaveBeenCalled();
  });

  it('rejects with 400 when the issuer is not a party to the referenced attestation', async () => {
    h.mockSelectLimit.mockResolvedValueOnce([
      { id: V1_ID, issuerDid: 'did:imajin:unrelated', subjectDid: 'did:imajin:also-unrelated', attestationStatus: 'bilateral' },
    ]);

    const res = await POST(makeReq(supersedingBody()));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/party to/);
    expect(h.mockInsertValues).not.toHaveBeenCalled();
  });

  it('rejects with 400 when the referenced attestation is not bilateral', async () => {
    h.mockSelectLimit.mockResolvedValueOnce([
      { id: V1_ID, issuerDid: ISSUER, subjectDid: SUBJECT, attestationStatus: 'pending' },
    ]);

    const res = await POST(makeReq(supersedingBody()));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/bilateral/);
    expect(h.mockInsertValues).not.toHaveBeenCalled();
  });

  it('accepts and persists supersedes when the issuer is a party to a bilateral target', async () => {
    // First select() call resolves the supersedes lookup; the persistent
    // default from beforeEach then serves the subsequent issuer-identity
    // lookup in verifyIssuerAndDelegation.
    h.mockSelectLimit.mockResolvedValueOnce([
      { id: V1_ID, issuerDid: ISSUER, subjectDid: SUBJECT, attestationStatus: 'bilateral' },
    ]);

    const res = await POST(makeReq(supersedingBody()));

    expect(res.status).toBe(201);
    expect(h.mockInsertValues).toHaveBeenCalledWith(expect.objectContaining({ supersedes: V1_ID }));
  });

  it('never validates supersedes when the payload does not carry one', async () => {
    await POST(makeReq(baseBody()));

    // Only the issuer-identity lookup runs — a single select() call.
    expect(h.mockSelectLimit).toHaveBeenCalledTimes(1);
    expect(h.mockInsertValues).toHaveBeenCalledWith(expect.objectContaining({ supersedes: null }));
  });
});

// #2394 — a registered third-party app can act as issuer_did on a
// delegated attestation: its Ed25519 key resolves from registry.apps (not
// auth.identities), and the delegation capability is the app's own
// namespaced attest:<appId>:<type> slot.
describe('app-delegated attestations (#2394)', () => {
  const APP_ID = 'app_dykil123';
  const APP_DID = 'did:imajin:app-dykil';

  function appDelegatedBody(overrides: Record<string, unknown> = {}) {
    return baseBody({
      issuer_did: APP_DID,
      type: 'survey_response',
      payload: { delegator_did: DELEGATOR },
      ...overrides,
    });
  }

  it('resolves the issuer public key from registry.apps and builds attest:<appId>:<type> for the delegation check', async () => {
    h.mockSelectLimit
      .mockResolvedValueOnce([]) // auth.identities miss
      .mockResolvedValueOnce([{ id: APP_ID, publicKey: 'app-public-key', status: 'active' }]); // registry.apps hit
    h.mockIntrospectGrant.mockResolvedValue({ authorized: true, grantId: 'grant_app_1', delegatorDid: DELEGATOR, agentDid: APP_DID });

    const res = await POST(makeReq(appDelegatedBody()));

    expect(res.status).toBe(201);
    expect(h.mockIntrospectGrant).toHaveBeenCalledWith({
      agentDid: APP_DID,
      capability: `attest:${APP_ID}:survey_response`,
      targetDid: SUBJECT,
      delegatorDid: DELEGATOR,
    });
    expect(h.mockInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({ issuerDid: APP_DID, delegatorDid: DELEGATOR, delegationGrantId: 'grant_app_1' }),
    );
  });

  it('rejects with 400 when issuer_did resolves to neither a plain identity nor an active registered app', async () => {
    h.mockSelectLimit
      .mockResolvedValueOnce([]) // auth.identities miss
      .mockResolvedValueOnce([]); // registry.apps miss

    const res = await POST(makeReq(appDelegatedBody()));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('Issuer DID not found');
    expect(h.mockInsertValues).not.toHaveBeenCalled();
  });

  it('rejects with 400 when the registry.apps row exists but has been revoked', async () => {
    h.mockSelectLimit
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: APP_ID, publicKey: 'app-public-key', status: 'revoked' }]);

    const res = await POST(makeReq(appDelegatedBody()));

    expect(res.status).toBe(400);
  });

  it('rejects with 403 when the app has no live grant for this attest capability (absent grant)', async () => {
    h.mockSelectLimit
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: APP_ID, publicKey: 'app-public-key', status: 'active' }]);
    h.mockIntrospectGrant.mockResolvedValue({ authorized: false, reason: 'No active, unexpired grant covers this capability and audience' });

    const res = await POST(makeReq(appDelegatedBody()));

    expect(res.status).toBe(403);
    expect(h.mockInsertValues).not.toHaveBeenCalled();
  });

  it('rejects with 403 when the grant for this attest capability has been revoked', async () => {
    h.mockSelectLimit
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: APP_ID, publicKey: 'app-public-key', status: 'active' }]);
    h.mockIntrospectGrant.mockResolvedValue({ authorized: false, reason: 'No active, unexpired grant covers this capability and audience' });

    const res = await POST(makeReq(appDelegatedBody()));

    expect(res.status).toBe(403);
  });
});

// #2394 — Ryan's 2026-09-26 ruling: an app authenticates its inbound call
// with a scoped app-token (POST /auth/api/tokens/app), verified locally and
// re-checked against the live app registry on every call.
describe('caller auth via scoped app-token (#2394)', () => {
  it('authenticates the caller from a valid session-app-token whose aud is a live registered app', async () => {
    h.mockVerifySessionAppTokenLocal.mockResolvedValue({ sub: DELEGATOR, aud: 'dykil.example.com', scopes: [] });
    h.mockResolveActiveAppByAudience.mockResolvedValue({ id: 'app_dykil', appDid: 'did:imajin:app-dykil', status: 'active' });

    const res = await POST(makeBearerReq(baseBody(), 'scoped-app-token'));

    expect(res.status).toBe(201);
    expect(h.mockResolveActiveAppByAudience).toHaveBeenCalledWith('dykil.example.com');
  });

  it('rejects with 401 when the token verifies but its aud is not a live registered app', async () => {
    h.mockVerifySessionAppTokenLocal.mockResolvedValue({ sub: DELEGATOR, aud: 'unregistered.example.com', scopes: [] });
    h.mockResolveActiveAppByAudience.mockResolvedValue(null);

    const res = await POST(makeBearerReq(baseBody(), 'scoped-app-token'));

    expect(res.status).toBe(401);
    expect(h.mockInsertValues).not.toHaveBeenCalled();
  });

  it('rejects with 401 when the bearer token is neither a legacy identity token nor a valid session-app-token', async () => {
    h.mockVerifySessionAppTokenLocal.mockResolvedValue(null);

    const res = await POST(makeBearerReq(baseBody(), 'garbage'));

    expect(res.status).toBe(401);
  });
});
