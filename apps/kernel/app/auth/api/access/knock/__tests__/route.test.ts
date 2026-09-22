/**
 * Tests for POST /auth/api/access/knock (#2252). Mirrors
 * `jin/api/vault-proposals/__tests__/route.test.ts`'s conventions, but this
 * route is deliberately NOT operator-gated — any signed-in identity may
 * knock for their own bearer (`principalDid` is always the caller's own
 * DID); only DECIDING the resulting card is operator-only.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OPERATOR_DID, otherHumanIdentity } from '@/src/lib/notify/__tests__/operator-approvals-test-helpers';

const { mockRequireAuth, mockGetOperatorDid, mockRecordApprovalRequested, mockCreateDelegateGrantKnock, mockValidateDelegateGrantKnockInput } = vi.hoisted(() => ({
  mockRequireAuth: vi.fn(),
  mockGetOperatorDid: vi.fn(),
  mockRecordApprovalRequested: vi.fn(),
  mockCreateDelegateGrantKnock: vi.fn(),
  mockValidateDelegateGrantKnockInput: vi.fn(),
}));

vi.mock('@imajin/auth', () => ({
  requireAuth: mockRequireAuth,
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

vi.mock('@/src/lib/access/delegate-grant', () => ({
  createDelegateGrantKnock: mockCreateDelegateGrantKnock,
  validateDelegateGrantKnockInput: mockValidateDelegateGrantKnockInput,
}));

import { POST, OPTIONS } from '../route';

function makeReq(body: unknown): Request {
  return new Request('https://test.imajin.ai/auth/api/access/knock', {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const VALID_BODY = {
  clientLabel: 'Muse Code',
  purpose: 'read my media',
  scopes: ['discovery:read'],
  surfaces: ['mcp'],
};

beforeEach(() => {
  vi.clearAllMocks();
  mockGetOperatorDid.mockResolvedValue(OPERATOR_DID);
  mockRequireAuth.mockResolvedValue({ identity: otherHumanIdentity() });
  mockValidateDelegateGrantKnockInput.mockReturnValue({ ok: true });
  mockCreateDelegateGrantKnock.mockResolvedValue({ ok: true, requestId: 'dgr_1', expiresAt: '2026-01-02T00:00:00.000Z', slidingWindowDays: 90 });
  mockRecordApprovalRequested.mockResolvedValue(undefined);
});

describe('OPTIONS /auth/api/access/knock', () => {
  it('delegates to the shared CORS preflight handler', async () => {
    const res = await OPTIONS(makeReq({}) as Parameters<typeof OPTIONS>[0]);
    expect(res.status).toBe(204);
  });
});

describe('POST /auth/api/access/knock — auth', () => {
  it('returns 401 when unauthenticated', async () => {
    mockRequireAuth.mockResolvedValueOnce({ error: 'Unauthorized', status: 401 });
    const res = await POST(makeReq(VALID_BODY) as Parameters<typeof POST>[0]);
    expect(res.status).toBe(401);
    expect(mockCreateDelegateGrantKnock).not.toHaveBeenCalled();
  });

  it('allows a non-operator human to knock for their own bearer', async () => {
    mockRequireAuth.mockResolvedValueOnce({ identity: otherHumanIdentity() });
    const res = await POST(makeReq(VALID_BODY) as Parameters<typeof POST>[0]);
    expect(res.status).toBe(201);
  });

  it('returns 503 when the node has no configured operator to approve the knock', async () => {
    mockGetOperatorDid.mockResolvedValueOnce(null);
    const res = await POST(makeReq(VALID_BODY) as Parameters<typeof POST>[0]);
    expect(res.status).toBe(503);
    expect(mockCreateDelegateGrantKnock).not.toHaveBeenCalled();
  });
});

describe('POST /auth/api/access/knock — validation', () => {
  it('returns 400 for malformed JSON', async () => {
    const res = await POST(makeReq('not json') as Parameters<typeof POST>[0]);
    expect(res.status).toBe(400);
  });

  it('returns 400 with the validator error when input is invalid', async () => {
    mockValidateDelegateGrantKnockInput.mockReturnValue({ ok: false, error: 'scopes must be a non-empty array' });
    const res = await POST(makeReq({ ...VALID_BODY, scopes: [] }) as Parameters<typeof POST>[0]);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('scopes must be a non-empty array');
    expect(mockCreateDelegateGrantKnock).not.toHaveBeenCalled();
  });
});

describe('POST /auth/api/access/knock — success', () => {
  it('resolves principalDid to the caller\u2019s own DID, never a body-supplied one', async () => {
    const identity = otherHumanIdentity();
    mockRequireAuth.mockResolvedValueOnce({ identity });

    await POST(makeReq({ ...VALID_BODY, principalDid: 'did:imajin:someone-i-am-not' }) as Parameters<typeof POST>[0]);

    expect(mockCreateDelegateGrantKnock).toHaveBeenCalledWith(expect.objectContaining({ principalDid: identity.id }));
  });

  it('raises an access:bearer-grant proposal addressed to the operator', async () => {
    await POST(makeReq(VALID_BODY) as Parameters<typeof POST>[0]);

    expect(mockRecordApprovalRequested).toHaveBeenCalledTimes(1);
    const [call] = mockRecordApprovalRequested.mock.calls[0]!;
    expect(call.source).toBe('access');
    expect(call.kind).toBe('access:bearer-grant');
    expect(call.operatorDid).toBe(OPERATOR_DID);
    expect(call.detail).toMatchObject({ requestId: 'dgr_1', clientLabel: 'Muse Code', purpose: 'read my media' });
  });

  it('returns 201 with requestId, proposalId, and expiresAt', async () => {
    const res = await POST(makeReq(VALID_BODY) as Parameters<typeof POST>[0]);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { requestId: string; proposalId: string; expiresAt: string };
    expect(body.requestId).toBe('dgr_1');
    expect(typeof body.proposalId).toBe('string');
    expect(body.expiresAt).toBe('2026-01-02T00:00:00.000Z');
  });

  it('surfaces a createDelegateGrantKnock failure as 400 without raising a proposal', async () => {
    mockCreateDelegateGrantKnock.mockResolvedValue({ ok: false, error: 'clientLabel is required' });
    const res = await POST(makeReq(VALID_BODY) as Parameters<typeof POST>[0]);
    expect(res.status).toBe(400);
    expect(mockRecordApprovalRequested).not.toHaveBeenCalled();
  });

  it('returns 500 without leaking failure detail when recordApprovalRequested throws', async () => {
    mockRecordApprovalRequested.mockRejectedValueOnce(new Error('db unavailable'));
    const res = await POST(makeReq(VALID_BODY) as Parameters<typeof POST>[0]);
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).not.toContain('db unavailable');
  });
});
