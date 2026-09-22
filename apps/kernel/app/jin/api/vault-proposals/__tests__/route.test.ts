/**
 * Tests for POST /jin/api/vault-proposals (#2247).
 *
 * Mirrors the decision route's own test conventions: real
 * `isOperatorIdentity` (only `getOperatorDid` is mocked) so the operator
 * gate is exercised for real, not stood in for.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  OPERATOR_DID,
  operatorIdentity,
  otherHumanIdentity,
  agentActingForOperatorIdentity,
} from '@/src/lib/notify/__tests__/operator-approvals-test-helpers';

const { mockRequireAuth, mockGetOperatorDid, mockRecordApprovalRequested } = vi.hoisted(() => ({
  mockRequireAuth: vi.fn(),
  mockGetOperatorDid: vi.fn(),
  mockRecordApprovalRequested: vi.fn(),
}));

vi.mock('@imajin/auth', () => ({
  requireAuth: mockRequireAuth,
  // computeApprovalContentHash (real implementation, via importOriginal
  // below) canonicalizes before hashing — a trivial JSON.stringify
  // pass-through is enough here since no test asserts on the exact hash.
  canonicalize: (obj: unknown) => JSON.stringify(obj),
}));

vi.mock('@/src/lib/kernel/cors', () => ({
  corsHeaders: () => new Headers(),
  corsOptions: () => new Response(null, { status: 204 }),
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

vi.mock('@/src/lib/kernel/node-identity', () => ({ getNodeSelfInfo: vi.fn() }));
vi.mock('@/src/db', () => ({ db: {}, identities: {} }));

vi.mock('@/src/lib/notify/operator-approvals', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/src/lib/notify/operator-approvals')>();
  return { ...actual, getOperatorDid: mockGetOperatorDid };
});

vi.mock('@/src/lib/notify/operator-approvals-service', () => ({
  recordApprovalRequested: mockRecordApprovalRequested,
}));

import { POST, OPTIONS } from '../route';

function makeReq(body: unknown): Request {
  return new Request('https://test.imajin.ai/jin/api/vault-proposals', {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetOperatorDid.mockResolvedValue(OPERATOR_DID);
  mockRequireAuth.mockResolvedValue({ identity: operatorIdentity() });
  mockRecordApprovalRequested.mockResolvedValue(undefined);
});

describe('OPTIONS /jin/api/vault-proposals', () => {
  it('delegates to the shared CORS preflight handler', async () => {
    const res = await OPTIONS(makeReq({}) as Parameters<typeof OPTIONS>[0]);
    expect(res.status).toBe(204);
  });
});

describe('POST /jin/api/vault-proposals — auth', () => {
  it('returns 401 when unauthenticated', async () => {
    mockRequireAuth.mockResolvedValueOnce({ error: 'Unauthorized', status: 401 });

    const res = await POST(makeReq({ kind: 'mint', detail: {} }) as Parameters<typeof POST>[0]);

    expect(res.status).toBe(401);
    expect(mockRecordApprovalRequested).not.toHaveBeenCalled();
  });

  it('rejects a non-operator human with 403', async () => {
    mockRequireAuth.mockResolvedValueOnce({ identity: otherHumanIdentity() });

    const res = await POST(makeReq({ kind: 'mint', detail: {} }) as Parameters<typeof POST>[0]);

    expect(res.status).toBe(403);
    expect(mockRecordApprovalRequested).not.toHaveBeenCalled();
  });

  it('rejects an agent acting for the operator via X-Acting-For with 403', async () => {
    mockRequireAuth.mockResolvedValueOnce({ identity: agentActingForOperatorIdentity() });

    const res = await POST(makeReq({ kind: 'mint', detail: {} }) as Parameters<typeof POST>[0]);

    expect(res.status).toBe(403);
    expect(mockRecordApprovalRequested).not.toHaveBeenCalled();
  });
});

describe('POST /jin/api/vault-proposals — validation', () => {
  it('returns 400 for malformed JSON', async () => {
    const res = await POST(makeReq('not json') as Parameters<typeof POST>[0]);
    expect(res.status).toBe(400);
  });

  it("returns 400 for a kind not in 'mint' | 'grant' | 'rotate' | 'revoke'", async () => {
    const res = await POST(makeReq({ kind: 'claim', detail: {} }) as Parameters<typeof POST>[0]);
    expect(res.status).toBe(400);
    expect(mockRecordApprovalRequested).not.toHaveBeenCalled();
  });

  it('rejects a mint proposal missing purpose', async () => {
    const res = await POST(makeReq({ kind: 'mint', detail: { requesterDid: 'did:imajin:x' } }) as Parameters<typeof POST>[0]);
    expect(res.status).toBe(400);
  });

  it('rejects a mint proposal missing requesterDid', async () => {
    const res = await POST(makeReq({ kind: 'mint', detail: { purpose: 'x' } }) as Parameters<typeof POST>[0]);
    expect(res.status).toBe(400);
  });

  // grant/rotate/revoke all require detail.did; grant additionally requires
  // grantedTo, but the empty-detail case rejects on the first missing field
  // for all three (S5976: parameterized rather than three near-identical bodies).
  it.each(['grant', 'rotate', 'revoke'] as const)("rejects a '%s' proposal with an empty detail", async (kind) => {
    const res = await POST(makeReq({ kind, detail: {} }) as Parameters<typeof POST>[0]);
    expect(res.status).toBe(400);
  });

  it('rejects a revoke proposal with an invalid tier', async () => {
    const res = await POST(makeReq({ kind: 'revoke', detail: { did: 'did:imajin:x', tier: 'nuke' } }) as Parameters<typeof POST>[0]);
    expect(res.status).toBe(400);
  });
});

describe('POST /jin/api/vault-proposals — success', () => {
  it('records a vault:mint proposal and returns 201 with a proposalId', async () => {
    const res = await POST(makeReq({ kind: 'mint', detail: { purpose: 'corpus-identity', requesterDid: 'did:imajin:corpus-bootstrap' } }) as Parameters<typeof POST>[0]);

    expect(res.status).toBe(201);
    const body = (await res.json()) as { proposalId: string };
    expect(typeof body.proposalId).toBe('string');

    expect(mockRecordApprovalRequested).toHaveBeenCalledTimes(1);
    const [call] = mockRecordApprovalRequested.mock.calls[0]!;
    expect(call.source).toBe('vault');
    expect(call.kind).toBe('vault:mint');
    expect(call.operatorDid).toBe(OPERATOR_DID);
    expect(call.notificationId).toBeNull();
    expect(call.detail).toEqual({ purpose: 'corpus-identity', requesterDid: 'did:imajin:corpus-bootstrap' });
  });

  it('records a vault:revoke proposal with a default tier of withdraw when none supplied', async () => {
    await POST(makeReq({ kind: 'revoke', detail: { did: 'did:imajin:x' } }) as Parameters<typeof POST>[0]);

    const [call] = mockRecordApprovalRequested.mock.calls[0]!;
    expect(call.kind).toBe('vault:revoke');
    expect(call.summary).toContain('Withdraw');
  });

  it('records a vault:revoke destroy proposal with destroy-specific summary copy', async () => {
    await POST(makeReq({ kind: 'revoke', detail: { did: 'did:imajin:x', tier: 'destroy' } }) as Parameters<typeof POST>[0]);

    const [call] = mockRecordApprovalRequested.mock.calls[0]!;
    expect(call.summary).toContain('Destroy');
  });

  it('records a vault:grant proposal with keysTouched set to the target did', async () => {
    await POST(makeReq({ kind: 'grant', detail: { did: 'did:imajin:x', grantedTo: 'did:imajin:prod-corpus' } }) as Parameters<typeof POST>[0]);

    const [call] = mockRecordApprovalRequested.mock.calls[0]!;
    expect(call.kind).toBe('vault:grant');
    expect(call.keysTouched).toEqual(['did:imajin:x']);
  });

  it('records a vault:rotate proposal', async () => {
    await POST(makeReq({ kind: 'rotate', detail: { did: 'did:imajin:x' } }) as Parameters<typeof POST>[0]);

    const [call] = mockRecordApprovalRequested.mock.calls[0]!;
    expect(call.kind).toBe('vault:rotate');
  });

  it('returns 500 without leaking failure detail when recordApprovalRequested throws', async () => {
    mockRecordApprovalRequested.mockRejectedValueOnce(new Error('db unavailable'));

    const res = await POST(makeReq({ kind: 'mint', detail: { purpose: 'x', requesterDid: 'did:imajin:x' } }) as Parameters<typeof POST>[0]);

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).not.toContain('db unavailable');
  });
});
