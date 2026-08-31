import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ───────────────────────────────────────────────────────────────────

const { mockRequireAppAuth, mockRequireAuth, mockRaise, mockList } = vi.hoisted(() => ({
  mockRequireAppAuth: vi.fn(),
  mockRequireAuth: vi.fn(),
  mockRaise: vi.fn(),
  mockList: vi.fn(),
}));

vi.mock('@imajin/auth', () => ({
  requireAppAuth: mockRequireAppAuth,
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
  raiseConsentRequest: mockRaise,
  listConsentRequestCards: mockList,
  parseStatusFilter: (raw: string | null) => {
    if (!raw) return ['pending', 'approved', 'rejected'];
    const valid = new Set(['pending', 'approved', 'rejected', 'expired']);
    const statuses = raw.split(',').map((s) => s.trim()).filter((s) => valid.has(s));
    return statuses.length > 0 ? statuses : null;
  },
}));

// ─── Subject ──────────────────────────────────────────────────────────────────

import { POST, GET } from '../route';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const APP_DID = 'did:imajin:openclaw-plugin';
const USER_DID = 'did:imajin:human';

const SAMPLE_CARD = {
  id: 'creq_test123',
  requesterDid: APP_DID,
  approverDid: USER_DID,
  kind: 'openclaw.exec_command',
  summary: 'Run the deploy script',
  detail: null,
  status: 'pending',
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  resolvedAt: null,
  decisionId: null,
  createdAt: new Date().toISOString(),
};

function makePostReq(body: Record<string, unknown>): Request {
  return new Request('https://test.imajin.ai/consent/api/requests', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

function makeGetReq(query = ''): Request {
  return new Request(`https://test.imajin.ai/consent/api/requests${query}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireAppAuth.mockResolvedValue({
    appAuth: { appDid: APP_DID, userDid: USER_DID, scopes: ['consent:write'], attestationId: 'att_1' },
  });
  mockRequireAuth.mockResolvedValue({ identity: { id: USER_DID } });
  mockRaise.mockResolvedValue(SAMPLE_CARD);
  mockList.mockResolvedValue([SAMPLE_CARD]);
});

// ─── POST (raise) ────────────────────────────────────────────────────────────

describe('POST /consent/api/requests — raise (#1817)', () => {
  it('is scope-gated: rejects an app token missing consent:write', async () => {
    mockRequireAppAuth.mockResolvedValueOnce({ error: 'Missing required scope: consent:write', status: 403 });

    const res = await POST(makePostReq({ kind: 'openclaw.exec_command', summary: 'do it' }) as Parameters<typeof POST>[0]);
    expect(res.status).toBe(403);
    expect(mockRequireAppAuth).toHaveBeenCalledWith(expect.anything(), { scope: 'consent:write' });
    expect(mockRaise).not.toHaveBeenCalled();
  });

  it('returns 401 when there is no app credential at all', async () => {
    mockRequireAppAuth.mockResolvedValueOnce({ error: 'Authorization Bearer <app-token> required', status: 401 });

    const res = await POST(makePostReq({ kind: 'k', summary: 's' }) as Parameters<typeof POST>[0]);
    expect(res.status).toBe(401);
  });

  it('raises a request, defaulting approverDid to the delegating user', async () => {
    const res = await POST(
      makePostReq({ kind: 'openclaw.exec_command', summary: 'Run the deploy script' }) as Parameters<typeof POST>[0],
    );

    expect(res.status).toBe(201);
    expect(mockRaise).toHaveBeenCalledWith(
      expect.objectContaining({
        requesterDid: APP_DID,
        approverDid: USER_DID,
        kind: 'openclaw.exec_command',
        summary: 'Run the deploy script',
        requesterScope: 'consent:write',
      }),
    );
    const body = (await res.json()) as { request: typeof SAMPLE_CARD };
    expect(body.request.id).toBe(SAMPLE_CARD.id);
  });

  it('honors an explicit approverDid in the body', async () => {
    const OTHER = 'did:imajin:other-approver';
    await POST(
      makePostReq({ approverDid: OTHER, kind: 'k', summary: 's' }) as Parameters<typeof POST>[0],
    );
    expect(mockRaise).toHaveBeenCalledWith(expect.objectContaining({ approverDid: OTHER }));
  });

  it('returns 400 when approverDid cannot be resolved (service token, no override)', async () => {
    mockRequireAppAuth.mockResolvedValueOnce({
      appAuth: { appDid: APP_DID, userDid: '', scopes: ['consent:write'], attestationId: '', isServiceToken: true },
    });

    const res = await POST(makePostReq({ kind: 'k', summary: 's' }) as Parameters<typeof POST>[0]);
    expect(res.status).toBe(400);
    expect(mockRaise).not.toHaveBeenCalled();
  });

  it('returns 400 when kind is missing', async () => {
    const res = await POST(makePostReq({ summary: 's' }) as Parameters<typeof POST>[0]);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/kind/);
  });

  it('returns 400 when summary is missing', async () => {
    const res = await POST(makePostReq({ kind: 'k' }) as Parameters<typeof POST>[0]);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/summary/);
  });

  it('returns 400 when detail is not a plain object', async () => {
    const res = await POST(makePostReq({ kind: 'k', summary: 's', detail: 'nope' }) as Parameters<typeof POST>[0]);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/detail/);
  });
});

// ─── GET (list) ──────────────────────────────────────────────────────────────

describe('GET /consent/api/requests — list (#1817)', () => {
  it('returns 401 when unauthenticated', async () => {
    mockRequireAuth.mockResolvedValueOnce({ error: 'Unauthorized', status: 401 });
    const res = await GET(makeGetReq() as Parameters<typeof GET>[0]);
    expect(res.status).toBe(401);
  });

  it('lists the approver-role cards by default', async () => {
    const res = await GET(makeGetReq() as Parameters<typeof GET>[0]);
    expect(res.status).toBe(200);
    expect(mockList).toHaveBeenCalledWith(USER_DID, 'approver', ['pending', 'approved', 'rejected']);
    const body = (await res.json()) as { requests: (typeof SAMPLE_CARD)[] };
    expect(body.requests).toHaveLength(1);
  });

  it('supports role=requester', async () => {
    await GET(makeGetReq('?role=requester') as Parameters<typeof GET>[0]);
    expect(mockList).toHaveBeenCalledWith(USER_DID, 'requester', ['pending', 'approved', 'rejected']);
  });

  it('supports a status filter', async () => {
    await GET(makeGetReq('?status=expired') as Parameters<typeof GET>[0]);
    expect(mockList).toHaveBeenCalledWith(USER_DID, 'approver', ['expired']);
  });

  it('returns 400 for an invalid status filter', async () => {
    const res = await GET(makeGetReq('?status=bogus') as Parameters<typeof GET>[0]);
    expect(res.status).toBe(400);
  });
});
