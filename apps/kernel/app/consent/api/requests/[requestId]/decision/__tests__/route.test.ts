import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ───────────────────────────────────────────────────────────────────

const { mockRequireAuth, mockDecide } = vi.hoisted(() => ({
  mockRequireAuth: vi.fn(),
  mockDecide: vi.fn(),
}));

vi.mock('@imajin/auth', () => ({
  requireAuth: mockRequireAuth,
  resolveActingDid: (identity: { id: string }) => identity.id,
}));

vi.mock('@/src/lib/kernel/cors', () => ({
  corsHeaders: () => new Headers(),
  corsOptions: () => new Response(null, { status: 204 }),
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

vi.mock('@/src/lib/consent-requests/consent-requests', () => ({
  decideConsentRequest: mockDecide,
}));

// ─── Subject ──────────────────────────────────────────────────────────────────

import { POST } from '../route';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const APPROVER_DID = 'did:imajin:human';
const REQUESTER_DID = 'did:imajin:openclaw-plugin';
const REQUEST_ID = 'creq_test123';

function makeReq(body: unknown): Request {
  return new Request(`https://test.imajin.ai/consent/api/requests/${REQUEST_ID}/decision`, {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function paramsFor(id: string) {
  return { params: Promise.resolve({ requestId: id }) };
}

const APPROVED_RESULT = {
  ok: true as const,
  request: {
    id: REQUEST_ID,
    requesterDid: REQUESTER_DID,
    approverDid: APPROVER_DID,
    kind: 'openclaw.exec_command',
    summary: 'Run the deploy script',
    detail: null,
    status: 'approved',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    resolvedAt: new Date().toISOString(),
    decisionId: 'cdec_1',
    createdAt: new Date().toISOString(),
  },
  decision: {
    id: 'cdec_1',
    requestId: REQUEST_ID,
    requesterDid: REQUESTER_DID,
    approverDid: APPROVER_DID,
    decision: 'approve' as const,
    payload: { requestId: REQUEST_ID },
    signature: 'sig',
    senderPubkey: 'pub',
    signedAt: new Date().toISOString(),
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireAuth.mockResolvedValue({ identity: { id: APPROVER_DID } });
  mockDecide.mockResolvedValue(APPROVED_RESULT);
});

describe('POST /consent/api/requests/:requestId/decision (#1817)', () => {
  it('returns 401 when unauthenticated', async () => {
    mockRequireAuth.mockResolvedValueOnce({ error: 'Unauthorized', status: 401 });
    const res = await POST(makeReq({ decision: 'approve' }) as Parameters<typeof POST>[0], paramsFor(REQUEST_ID));
    expect(res.status).toBe(401);
    expect(mockDecide).not.toHaveBeenCalled();
  });

  it('returns 400 for a malformed body', async () => {
    const res = await POST(makeReq('not json') as Parameters<typeof POST>[0], paramsFor(REQUEST_ID));
    expect(res.status).toBe(400);
  });

  it("returns 400 when decision is neither 'approve' nor 'reject'", async () => {
    const res = await POST(makeReq({ decision: 'maybe' }) as Parameters<typeof POST>[0], paramsFor(REQUEST_ID));
    expect(res.status).toBe(400);
    expect(mockDecide).not.toHaveBeenCalled();
  });

  it('approves and returns the request + signed attestation', async () => {
    const res = await POST(makeReq({ decision: 'approve' }) as Parameters<typeof POST>[0], paramsFor(REQUEST_ID));

    expect(mockDecide).toHaveBeenCalledWith({
      requestId: REQUEST_ID,
      approverDid: APPROVER_DID,
      decision: 'approve',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { request: { status: string }; decision: { id: string } };
    expect(body.request.status).toBe('approved');
    expect(body.decision.id).toBe('cdec_1');
  });

  it('rejects and forwards the reject decision', async () => {
    mockDecide.mockResolvedValueOnce({
      ...APPROVED_RESULT,
      request: { ...APPROVED_RESULT.request, status: 'rejected' },
      decision: { ...APPROVED_RESULT.decision, decision: 'reject' },
    });

    const res = await POST(makeReq({ decision: 'reject' }) as Parameters<typeof POST>[0], paramsFor(REQUEST_ID));
    expect(mockDecide).toHaveBeenCalledWith({
      requestId: REQUEST_ID,
      approverDid: APPROVER_DID,
      decision: 'reject',
    });
    const body = (await res.json()) as { request: { status: string } };
    expect(body.request.status).toBe('rejected');
  });

  it('propagates a 409 when the request has expired', async () => {
    mockDecide.mockResolvedValueOnce({ ok: false, error: 'Consent request has expired', status: 409 });
    const res = await POST(makeReq({ decision: 'approve' }) as Parameters<typeof POST>[0], paramsFor(REQUEST_ID));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/expired/);
  });

  it('propagates a 403 when the caller is not the addressed approver', async () => {
    mockDecide.mockResolvedValueOnce({
      ok: false,
      error: 'You are not the approver for this consent request',
      status: 403,
    });
    const res = await POST(makeReq({ decision: 'approve' }) as Parameters<typeof POST>[0], paramsFor(REQUEST_ID));
    expect(res.status).toBe(403);
  });

  it('propagates a 404 for an unknown request', async () => {
    mockDecide.mockResolvedValueOnce({ ok: false, error: 'Consent request not found', status: 404 });
    const res = await POST(makeReq({ decision: 'approve' }) as Parameters<typeof POST>[0], paramsFor(REQUEST_ID));
    expect(res.status).toBe(404);
  });
});
