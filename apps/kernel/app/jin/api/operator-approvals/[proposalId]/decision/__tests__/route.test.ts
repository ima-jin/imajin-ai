/**
 * Tests for POST /jin/api/operator-approvals/:proposalId/decision (#2059).
 *
 * Covers the full acceptance list: operator approve/deny, non-operator and
 * agent (`X-Acting-For`) rejection, unknown-proposal 404, and bad-body 400.
 * `isOperatorIdentity` runs for real here (only `getOperatorDid` is mocked)
 * so these tests exercise the actual load-bearing auth check, not a stand-in.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  OPERATOR_DID,
  PROPOSAL_ID,
  operatorIdentity,
  otherHumanIdentity,
  agentActingForOperatorIdentity,
  pendingApprovalCard,
} from '@/src/lib/notify/__tests__/operator-approvals-test-helpers';

// ─── Mocks ───────────────────────────────────────────────────────────────────

const { mockRequireAuth, mockGetOperatorDid, mockDecide } = vi.hoisted(() => ({
  mockRequireAuth: vi.fn(),
  mockGetOperatorDid: vi.fn(),
  mockDecide: vi.fn(),
}));

vi.mock('@imajin/auth', () => ({ requireAuth: mockRequireAuth }));

vi.mock('@/src/lib/kernel/cors', () => ({
  corsHeaders: () => new Headers(),
  corsOptions: () => new Response(null, { status: 204 }),
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

// operator-approvals.ts imports node-identity.ts, which calls getClient() at
// module scope (requires DATABASE_URL). Stub it so importOriginal() below can
// load the real (pure) validator/isOperatorIdentity code without a DB.
vi.mock('@/src/lib/kernel/node-identity', () => ({ getNodeSelfInfo: vi.fn() }));

vi.mock('@/src/lib/notify/operator-approvals', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/src/lib/notify/operator-approvals')>();
  return { ...actual, getOperatorDid: mockGetOperatorDid };
});

vi.mock('@/src/lib/notify/operator-approvals-service', () => ({
  decideOperatorApproval: mockDecide,
}));

// ─── Subject ──────────────────────────────────────────────────

import { POST, OPTIONS } from '../route';

function makeReq(body: unknown): Request {
  return new Request(`https://test.imajin.ai/jin/api/operator-approvals/${PROPOSAL_ID}/decision`, {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function paramsFor(id: string) {
  return { params: Promise.resolve({ proposalId: id }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetOperatorDid.mockResolvedValue(OPERATOR_DID);
  mockRequireAuth.mockResolvedValue({ identity: operatorIdentity() });
  mockDecide.mockResolvedValue({ ok: true, card: pendingApprovalCard({ status: 'approved' }) });
});

describe('OPTIONS /jin/api/operator-approvals/:proposalId/decision', () => {
  it('delegates to the shared CORS preflight handler', async () => {
    const res = await OPTIONS(makeReq({}) as Parameters<typeof OPTIONS>[0]);
    expect(res.status).toBe(204);
  });
});

describe('POST /jin/api/operator-approvals/:proposalId/decision (#2059)', () => {
  it('returns 401 when unauthenticated', async () => {
    mockRequireAuth.mockResolvedValueOnce({ error: 'Unauthorized', status: 401 });
    const res = await POST(makeReq({ decision: 'approve' }) as Parameters<typeof POST>[0], paramsFor(PROPOSAL_ID));
    expect(res.status).toBe(401);
    expect(mockDecide).not.toHaveBeenCalled();
  });

  it('approves and returns the signed card, calling the service as the operator DID', async () => {
    const res = await POST(makeReq({ decision: 'approve' }) as Parameters<typeof POST>[0], paramsFor(PROPOSAL_ID));

    expect(mockDecide).toHaveBeenCalledWith({
      proposalId: PROPOSAL_ID,
      operatorDid: OPERATOR_DID,
      decision: 'approve',
      reason: undefined,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { approval: { status: string } };
    expect(body.approval.status).toBe('approved');
  });

  it('denies and forwards the deny decision with an optional reason', async () => {
    mockDecide.mockResolvedValueOnce({ ok: true, card: pendingApprovalCard({ status: 'denied' }) });

    const res = await POST(
      makeReq({ decision: 'deny', reason: 'not tonight' }) as Parameters<typeof POST>[0],
      paramsFor(PROPOSAL_ID),
    );

    expect(mockDecide).toHaveBeenCalledWith({
      proposalId: PROPOSAL_ID,
      operatorDid: OPERATOR_DID,
      decision: 'deny',
      reason: 'not tonight',
    });
    const body = (await res.json()) as { approval: { status: string } };
    expect(body.approval.status).toBe('denied');
  });

  it('forwards a withdrawn decision', async () => {
    mockDecide.mockResolvedValueOnce({ ok: true, card: pendingApprovalCard({ status: 'withdrawn' }) });

    const res = await POST(makeReq({ decision: 'withdrawn' }) as Parameters<typeof POST>[0], paramsFor(PROPOSAL_ID));

    expect(mockDecide).toHaveBeenCalledWith(
      expect.objectContaining({ decision: 'withdrawn' }),
    );
    expect(res.status).toBe(200);
  });

  it("rejects a non-operator human with 403 and never calls the service (#2059 acceptance (c))", async () => {
    mockRequireAuth.mockResolvedValueOnce({ identity: otherHumanIdentity() });

    const res = await POST(makeReq({ decision: 'approve' }) as Parameters<typeof POST>[0], paramsFor(PROPOSAL_ID));

    expect(res.status).toBe(403);
    expect(mockDecide).not.toHaveBeenCalled();
  });

  it("rejects @jin acting for the operator via X-Acting-For with 403 (#2059 acceptance (d), the load-bearing rule)", async () => {
    mockRequireAuth.mockResolvedValueOnce({ identity: agentActingForOperatorIdentity() });

    const res = await POST(makeReq({ decision: 'approve' }) as Parameters<typeof POST>[0], paramsFor(PROPOSAL_ID));

    expect(res.status).toBe(403);
    expect(mockDecide).not.toHaveBeenCalled();
  });

  it('rejects with 403 when no operator DID is configured at all', async () => {
    mockGetOperatorDid.mockResolvedValueOnce(null);

    const res = await POST(makeReq({ decision: 'approve' }) as Parameters<typeof POST>[0], paramsFor(PROPOSAL_ID));

    expect(res.status).toBe(403);
    expect(mockDecide).not.toHaveBeenCalled();
  });

  it('returns 400 for a malformed JSON body', async () => {
    const res = await POST(makeReq('not json') as Parameters<typeof POST>[0], paramsFor(PROPOSAL_ID));
    expect(res.status).toBe(400);
    expect(mockDecide).not.toHaveBeenCalled();
  });

  it("returns 400 when decision is not one of 'approve' | 'deny' | 'withdrawn'", async () => {
    const res = await POST(makeReq({ decision: 'maybe' }) as Parameters<typeof POST>[0], paramsFor(PROPOSAL_ID));
    expect(res.status).toBe(400);
    expect(mockDecide).not.toHaveBeenCalled();
  });

  it('propagates a 404 for an unknown proposal', async () => {
    mockDecide.mockResolvedValueOnce({ ok: false, error: 'Proposal not found', status: 404 });
    const res = await POST(makeReq({ decision: 'approve' }) as Parameters<typeof POST>[0], paramsFor(PROPOSAL_ID));
    expect(res.status).toBe(404);
  });

  it("propagates a 409 when withdraw is attempted outside pending-apply (#2059 acceptance (f))", async () => {
    mockDecide.mockResolvedValueOnce({
      ok: false,
      error: 'Proposal is not awaiting this decision (status: applied)',
      status: 409,
    });
    const res = await POST(makeReq({ decision: 'withdrawn' }) as Parameters<typeof POST>[0], paramsFor(PROPOSAL_ID));
    expect(res.status).toBe(409);
  });

  it('returns 500 without leaking the failure detail when decideOperatorApproval throws', async () => {
    mockDecide.mockRejectedValueOnce(new Error('db unavailable'));

    const res = await POST(makeReq({ decision: 'approve' }) as Parameters<typeof POST>[0], paramsFor(PROPOSAL_ID));

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('Failed to record decision');
    expect(body.error).not.toContain('db unavailable');
  });
});
