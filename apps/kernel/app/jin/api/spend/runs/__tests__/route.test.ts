import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockRequireAuth, mockGetOperatorDid, mockReadInterimSpend } = vi.hoisted(() => ({
  mockRequireAuth: vi.fn(),
  mockGetOperatorDid: vi.fn(),
  mockReadInterimSpend: vi.fn(),
}));

const OPERATOR_DID = 'did:imajin:operator';

vi.mock('@imajin/auth', () => ({ requireAuth: mockRequireAuth }));
vi.mock('@/src/lib/kernel/cors', () => ({
  corsHeaders: () => new Headers(),
  corsOptions: () => new Response(null, { status: 204 }),
}));
vi.mock('@/src/lib/kernel/node-identity', () => ({ getNodeSelfInfo: vi.fn() }));
vi.mock('@/src/lib/notify/operator-approvals', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/src/lib/notify/operator-approvals')>();
  return { ...actual, getOperatorDid: mockGetOperatorDid };
});
vi.mock('@/src/lib/jin/spend-interim-join', () => ({ readInterimSpend: mockReadInterimSpend }));

import { GET, OPTIONS } from '../route';

function makeReq(): Request {
  return new Request('https://test.imajin.ai/jin/api/spend/runs');
}
const call = () => GET(makeReq() as Parameters<typeof GET>[0]);

beforeEach(() => {
  vi.clearAllMocks();
  mockGetOperatorDid.mockResolvedValue(OPERATOR_DID);
  mockReadInterimSpend.mockResolvedValue({ runs: [], label: 'interim' });
});

describe('GET /jin/api/spend/runs (#2725, interim)', () => {
  it('delegates OPTIONS to the shared CORS preflight', async () => {
    const res = await OPTIONS(makeReq() as Parameters<typeof OPTIONS>[0]);
    expect(res.status).toBe(204);
  });

  it('returns 401 when unauthenticated and reads nothing', async () => {
    mockRequireAuth.mockResolvedValueOnce({ error: 'Unauthorized', status: 401 });
    const res = await call();
    expect(res.status).toBe(401);
    expect(mockReadInterimSpend).not.toHaveBeenCalled();
  });

  it('returns the interim derivation for the operator', async () => {
    mockRequireAuth.mockResolvedValueOnce({ identity: { id: OPERATOR_DID, actingFor: undefined } });
    const res = await call();
    expect(await res.json()).toEqual({ isOperator: true, interim: { runs: [], label: 'interim' } });
    expect(mockReadInterimSpend).toHaveBeenCalledWith(OPERATOR_DID);
  });

  it.each([
    ['another signed-in human', { id: 'did:imajin:someone-else', actingFor: undefined }],
    ['an agent acting for the operator', { id: 'did:imajin:jin', actingFor: OPERATOR_DID }],
  ])('gives %s nothing — Warp and GitHub are never touched', async (_label, identity) => {
    mockRequireAuth.mockResolvedValueOnce({ identity });
    const res = await call();
    expect(await res.json()).toEqual({ isOperator: false, interim: null });
    expect(mockReadInterimSpend).not.toHaveBeenCalled();
  });

  it('returns 500 without leaking the error when the derivation throws', async () => {
    mockRequireAuth.mockResolvedValueOnce({ identity: { id: OPERATOR_DID, actingFor: undefined } });
    mockReadInterimSpend.mockRejectedValueOnce(new Error('secret'));
    const res = await call();
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain('secret');
  });
});
