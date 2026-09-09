/**
 * Tests for POST /auth/api/eligibility/evaluate (#1999).
 *
 * Exercises the full path through checkHardEligibility (mocking only the DB
 * layer + emitAttestation), not just the route's own auth/parsing branches,
 * so these tests double as coverage for the hard-eligibility state machine
 * itself — the single owner apps/events' check-in route now delegates to
 * instead of re-deriving locally.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';
import { describeInternalApiKeyAuth, makeInternalKeyRequest } from '../../../__tests__/internal-api-key-auth-test-support';

const API_KEY = 'internal-api-key';
const DID = 'did:imajin:attendee';

const h = vi.hoisted(() => ({
  mockDbSelect: vi.fn(),
  mockDbUpdate: vi.fn(),
  mockEmitAttestation: vi.fn().mockResolvedValue(undefined),
  mockGetNodeDid: vi.fn().mockResolvedValue('did:imajin:node'),
}));

function makeQueryChain(result: unknown) {
  const chain: Record<string, unknown> = {};
  const self = () => chain;
  chain.from = vi.fn(self);
  chain.innerJoin = vi.fn(self);
  chain.where = vi.fn(self);
  chain.limit = vi.fn(async () => result);
  chain.set = vi.fn(self);
  chain.returning = vi.fn(async () => result);
  chain.then = (resolve: (v: unknown) => void) => resolve(result);
  return chain;
}

vi.mock('@/src/db', () => ({
  db: {
    select: (...args: unknown[]) => h.mockDbSelect(...args),
    update: (...args: unknown[]) => h.mockDbUpdate(...args),
  },
  identities: {},
  attestations: {},
  connections: {},
}));

vi.mock('@imajin/auth', () => ({
  emitAttestation: h.mockEmitAttestation,
}));

vi.mock('@/src/lib/kernel/node-identity', () => ({
  getNodeDid: h.mockGetNodeDid,
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

import { POST } from '../route';

function makeReq(body: unknown, apiKey: string | undefined = API_KEY): NextRequest {
  return makeInternalKeyRequest(body, apiKey);
}

/** Queue the identity lookup, connection count, and attendance rows for the eligible path. */
function queueEligiblePath(overrides: { handleClaimedAt?: Date; connCount?: number; attendance?: unknown[] } = {}) {
  const handleClaimedAt = overrides.handleClaimedAt ?? new Date(Date.now() - 35 * 24 * 60 * 60 * 1000);
  h.mockDbSelect.mockImplementationOnce(() => makeQueryChain([{ tier: 'preliminary', handleClaimedAt }]));
  h.mockDbSelect.mockImplementationOnce(() => makeQueryChain([{ total: overrides.connCount ?? 30 }]));
  h.mockDbSelect.mockImplementationOnce(() => makeQueryChain(overrides.attendance ?? [{ id: 'att_1' }]));
}

beforeEach(() => {
  vi.clearAllMocks();
  // clearAllMocks() does not drop queued mockImplementationOnce entries —
  // reset explicitly so a leftover queued call from a prior test (e.g. one
  // that returns early and never consumes all its queued selects) can't
  // leak into the next test's call order.
  h.mockDbSelect.mockReset();
  h.mockDbUpdate.mockReset();
  process.env.ATTESTATION_INTERNAL_API_KEY = API_KEY;
  h.mockEmitAttestation.mockResolvedValue(undefined);
  h.mockGetNodeDid.mockResolvedValue('did:imajin:node');
  h.mockDbUpdate.mockReturnValue(makeQueryChain([{ id: DID }]));
});

describeInternalApiKeyAuth({
  routeLabel: 'POST /auth/api/eligibility/evaluate',
  post: POST,
  apiKey: API_KEY,
  validBody: { did: DID },
  assertNoSideEffect: () => expect(h.mockDbSelect).not.toHaveBeenCalled(),
});

describe('POST /auth/api/eligibility/evaluate', () => {
  it('returns 400 for invalid JSON', async () => {
    const req = { headers: new Headers({ authorization: `Bearer ${API_KEY}` }), json: async () => { throw new Error('bad'); } } as unknown as NextRequest;
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it('returns 400 when did is missing', async () => {
    const res = await POST(makeReq({}));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'did required' });
  });

  it('returns 404 when the identity does not exist', async () => {
    h.mockDbSelect.mockImplementationOnce(() => makeQueryChain([]));
    const res = await POST(makeReq({ did: DID }));
    expect(res.status).toBe(404);
  });

  it('upgrades to established and emits identity.verified.hard when eligible', async () => {
    queueEligiblePath();
    const res = await POST(makeReq({ did: DID }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ did: DID, tier: 'established', upgraded: true });
    expect(h.mockEmitAttestation).toHaveBeenCalledWith(
      expect.objectContaining({
        issuer_did: 'did:imajin:node',
        subject_did: DID,
        type: 'identity.verified.hard',
      }),
    );
  });

  it('is a no-op when not yet eligible (insufficient connections)', async () => {
    queueEligiblePath({ connCount: 5 });
    const res = await POST(makeReq({ did: DID }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ did: DID, tier: 'preliminary', upgraded: false });
    expect(h.mockDbUpdate).not.toHaveBeenCalled();
    expect(h.mockEmitAttestation).not.toHaveBeenCalled();
  });

  it('is a no-op when not yet eligible (no attendance attestation)', async () => {
    queueEligiblePath({ attendance: [] });
    const res = await POST(makeReq({ did: DID }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ did: DID, tier: 'preliminary', upgraded: false });
    expect(h.mockDbUpdate).not.toHaveBeenCalled();
  });

  it('is idempotent — re-evaluating an already-established identity is a no-op', async () => {
    h.mockDbSelect.mockImplementationOnce(() => makeQueryChain([{ tier: 'established', handleClaimedAt: new Date() }]));
    const res = await POST(makeReq({ did: DID }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ did: DID, tier: 'established', upgraded: false });
    expect(h.mockDbUpdate).not.toHaveBeenCalled();
    expect(h.mockEmitAttestation).not.toHaveBeenCalled();
  });

  it('reports upgraded: false when a concurrent call already performed the CAS', async () => {
    queueEligiblePath();
    h.mockDbUpdate.mockReturnValue(makeQueryChain([])); // CAS returns no row — already upgraded elsewhere
    const res = await POST(makeReq({ did: DID }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ did: DID, tier: 'established', upgraded: false });
    expect(h.mockEmitAttestation).not.toHaveBeenCalled();
  });
});
