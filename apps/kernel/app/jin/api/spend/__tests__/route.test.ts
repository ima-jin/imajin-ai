import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ───────────────────────────────────────────────────────────────────

const { mockRequireAuth, mockGetOperatorDid, mockReadSpendLane } = vi.hoisted(() => ({
  mockRequireAuth: vi.fn(),
  mockGetOperatorDid: vi.fn(),
  mockReadSpendLane: vi.fn(),
}));

const OPERATOR_DID = 'did:imajin:operator';

vi.mock('@imajin/auth', () => ({ requireAuth: mockRequireAuth }));
vi.mock('@/src/lib/kernel/cors', () => ({
  corsHeaders: () => new Headers(),
  corsOptions: () => new Response(null, { status: 204 }),
}));
// operator-approvals.ts imports node-identity.ts, which needs a DB at module scope — stub it so the real
// (pure) isOperatorIdentity can load (same pattern as jin/api/grants's route test).
vi.mock('@/src/lib/kernel/node-identity', () => ({ getNodeSelfInfo: vi.fn() }));
vi.mock('@/src/lib/notify/operator-approvals', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/src/lib/notify/operator-approvals')>();
  return { ...actual, getOperatorDid: mockGetOperatorDid };
});
vi.mock('@/src/lib/jin/spend-lane', () => ({ readSpendLane: mockReadSpendLane }));

import { GET, OPTIONS } from '../route';

function makeReq(): Request {
  return new Request('https://test.imajin.ai/jin/api/spend');
}
const call = () => GET(makeReq() as Parameters<typeof GET>[0]);

beforeEach(() => {
  vi.clearAllMocks();
  mockGetOperatorDid.mockResolvedValue(OPERATOR_DID);
  mockReadSpendLane.mockResolvedValue({ providers: [], trend: [] });
});

describe('GET /jin/api/spend (#2725)', () => {
  it('delegates OPTIONS to the shared CORS preflight', async () => {
    const res = await OPTIONS(makeReq() as Parameters<typeof OPTIONS>[0]);
    expect(res.status).toBe(204);
  });

  it('returns 401 when unauthenticated and reads nothing', async () => {
    mockRequireAuth.mockResolvedValueOnce({ error: 'Unauthorized', status: 401 });
    const res = await call();
    expect(res.status).toBe(401);
    expect(mockReadSpendLane).not.toHaveBeenCalled();
  });

  it('returns the spend lane for the operator identity', async () => {
    mockRequireAuth.mockResolvedValueOnce({ identity: { id: OPERATOR_DID, actingFor: undefined } });
    const res = await call();
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(await res.json()).toEqual({ isOperator: true, spend: { providers: [], trend: [] } });
    expect(mockReadSpendLane).toHaveBeenCalledWith(OPERATOR_DID);
  });

  it.each([
    ['another signed-in human', { id: 'did:imajin:someone-else', actingFor: undefined }],
    ['an agent acting for the operator', { id: 'did:imajin:jin', actingFor: OPERATOR_DID }],
    ['the operator DID delegated via actingFor', { id: OPERATOR_DID, actingFor: 'did:imajin:other' }],
  ])('gives %s nothing — no spend data, never read', async (_label, identity) => {
    mockRequireAuth.mockResolvedValueOnce({ identity });
    const res = await call();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ isOperator: false, spend: null });
    expect(mockReadSpendLane).not.toHaveBeenCalled();
  });

  it('gives everyone nothing when the node has no operator DID', async () => {
    mockGetOperatorDid.mockResolvedValueOnce(null);
    mockRequireAuth.mockResolvedValueOnce({ identity: { id: OPERATOR_DID, actingFor: undefined } });
    const res = await call();
    expect(await res.json()).toEqual({ isOperator: false, spend: null });
    expect(mockReadSpendLane).not.toHaveBeenCalled();
  });

  it('returns 500 without leaking the error when the read fails', async () => {
    mockRequireAuth.mockResolvedValueOnce({ identity: { id: OPERATOR_DID, actingFor: undefined } });
    mockReadSpendLane.mockRejectedValueOnce(new Error('secret db detail'));
    const res = await call();
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain('secret');
  });
});
