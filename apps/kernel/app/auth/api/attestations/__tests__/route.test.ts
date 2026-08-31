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
  getSessionCookieOptions: () => ({ name: 'session' }),
}));

vi.mock('@/src/lib/auth/grants', () => ({
  introspectGrant: h.mockIntrospectGrant,
}));

vi.mock('@imajin/config', () => ({ corsHeaders: () => ({}) }));

vi.mock('@imajin/auth', () => ({
  canonicalize: (obj: unknown) => JSON.stringify(obj),
  crypto: { verifySync: () => true },
  ATTESTATION_TYPES: ['delivery.receipt', 'intro_proposed'],
  verifyNostrSig: vi.fn(),
  DISCLOSURE_SCOPES: ['parties', 'connections', 'network', 'public'],
  DEFAULT_DISCLOSURE_SCOPE: 'parties',
  isDisclosureScope: (v: string) => ['parties', 'connections', 'network', 'public'].includes(v),
  evidenceGradeForAttestationStatus: vi.fn(),
  capabilityForDelegatedAttestationType: (type: string) => (type === 'intro_proposed' ? 'intros:propose' : null),
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
