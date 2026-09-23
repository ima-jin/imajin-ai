import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockRequireAuth, mockGetLoopWithHistory } = vi.hoisted(() => ({
  mockRequireAuth: vi.fn(),
  mockGetLoopWithHistory: vi.fn(),
}));

vi.mock('@imajin/auth', () => ({
  requireAuth: mockRequireAuth,
  resolveActingDid: (identity: { id: string }) => identity.id,
}));

vi.mock('@/src/lib/kernel/cors', () => ({
  corsHeaders: () => new Headers(),
  corsOptions: () => new Response(null, { status: 204 }),
}));

vi.mock('@/src/lib/loops/query', () => ({
  getLoopWithHistory: mockGetLoopWithHistory,
}));

import { GET } from '../route';

const OPERATOR_DID = 'did:imajin:ryan';

function makeReq(): Request {
  return new Request('https://test.imajin.ai/api/loops/loop_abc123');
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/loops/{loopId}', () => {
  it('returns 401 without a lookup when unauthenticated', async () => {
    mockRequireAuth.mockResolvedValueOnce({ error: 'Unauthorized', status: 401 });

    const res = await GET(makeReq() as Parameters<typeof GET>[0], { params: Promise.resolve({ loopId: 'loop_abc123' }) });

    expect(res.status).toBe(401);
    expect(mockGetLoopWithHistory).not.toHaveBeenCalled();
  });

  it('returns 400 for a blank loopId', async () => {
    mockRequireAuth.mockResolvedValueOnce({ identity: { id: OPERATOR_DID } });

    const res = await GET(makeReq() as Parameters<typeof GET>[0], { params: Promise.resolve({ loopId: '   ' }) });

    expect(res.status).toBe(400);
    expect(mockGetLoopWithHistory).not.toHaveBeenCalled();
  });

  it('scopes the lookup to the effective DID', async () => {
    mockRequireAuth.mockResolvedValueOnce({ identity: { id: OPERATOR_DID } });
    mockGetLoopWithHistory.mockResolvedValueOnce(null);

    await GET(makeReq() as Parameters<typeof GET>[0], { params: Promise.resolve({ loopId: 'loop_abc123' }) });

    expect(mockGetLoopWithHistory).toHaveBeenCalledWith('loop_abc123', OPERATOR_DID);
  });

  it('returns 404 when the loop does not exist', async () => {
    mockRequireAuth.mockResolvedValueOnce({ identity: { id: OPERATOR_DID } });
    mockGetLoopWithHistory.mockResolvedValueOnce(null);

    const res = await GET(makeReq() as Parameters<typeof GET>[0], { params: Promise.resolve({ loopId: 'loop_missing' }) });

    expect(res.status).toBe(404);
  });

  it('returns 404 (not 403) when the loop belongs to a different principal — never reveals existence', async () => {
    // getLoopWithHistory itself scopes by principal and returns null for a
    // cross-principal loopId — the route has no separate branch that could
    // leak a 403/other-status distinction here.
    mockRequireAuth.mockResolvedValueOnce({ identity: { id: OPERATOR_DID } });
    mockGetLoopWithHistory.mockResolvedValueOnce(null);

    const res = await GET(makeReq() as Parameters<typeof GET>[0], { params: Promise.resolve({ loopId: 'loop_someone_elses' }) });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });

  it('returns the loop with its ordered event history on a hit', async () => {
    mockRequireAuth.mockResolvedValueOnce({ identity: { id: OPERATOR_DID } });
    const payload = {
      loop: { loopId: 'loop_abc123', kind: 'warp.run', state: 'succeeded' },
      events: [
        { id: 'evt_1', type: 'loop.started', occurredAt: '2026-09-22T00:00:00.000Z' },
        { id: 'evt_2', type: 'loop.finished', occurredAt: '2026-09-22T01:00:00.000Z' },
      ],
    };
    mockGetLoopWithHistory.mockResolvedValueOnce(payload);

    const res = await GET(makeReq() as Parameters<typeof GET>[0], { params: Promise.resolve({ loopId: 'loop_abc123' }) });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual(payload);
    expect(body.events.map((e: { type: string }) => e.type)).toEqual(['loop.started', 'loop.finished']);
  });
});
