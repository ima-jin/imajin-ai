/**
 * Tests for `/api/loops` (#2295): the signed ingest POST and the
 * per-principal list GET. `parseLoopIngestRequest` (wire-shape validation)
 * runs for real here — only `ingestLoopEvent` (which itself calls signature
 * verification + bus.publish) and the auth/query libs are mocked, so these
 * tests pin the route's own request/response wiring, not the crypto or SQL
 * underneath it (those have their own unit tests).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockRequireAuth, mockIngestLoopEvent, mockListLoops } = vi.hoisted(() => ({
  mockRequireAuth: vi.fn(),
  mockIngestLoopEvent: vi.fn(),
  mockListLoops: vi.fn(),
}));

vi.mock('@imajin/auth', () => ({
  requireAuth: mockRequireAuth,
  resolveActingDid: (identity: { id: string; actingFor?: string }) => identity.actingFor ?? identity.id,
  SIGNED_MESSAGE_MAX_AGE: 5 * 60 * 1000,
  FUTURE_TOLERANCE: 30 * 1000,
}));

vi.mock('@/src/lib/kernel/cors', () => ({
  corsHeaders: () => new Headers(),
  corsOptions: () => new Response(null, { status: 204 }),
}));

vi.mock('@/src/lib/loops/ingest', () => ({
  ingestLoopEvent: mockIngestLoopEvent,
}));

vi.mock('@/src/lib/loops/query', () => ({
  listLoops: mockListLoops,
}));

import { GET, POST, OPTIONS } from '../route';

const OPERATOR_DID = 'did:imajin:ryan';

function makeGetReq(query = ''): Request {
  return new Request(`https://test.imajin.ai/api/loops${query}`);
}

function makePostReq(body: unknown): Request {
  return new Request('https://test.imajin.ai/api/loops', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function validIngestBody(overrides: Record<string, unknown> = {}) {
  return {
    type: 'loop.started',
    payload: {
      loopId: 'loop_abc123',
      kind: 'warp.run',
      principal: OPERATOR_DID,
      state: 'queued',
      summary: 'Kicked off',
      at: new Date().toISOString(),
    },
    publisherDid: 'did:imajin:warp-node',
    signature: { keyId: 'a'.repeat(64), alg: 'ed25519', sig: 'b'.repeat(128) },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('OPTIONS /api/loops', () => {
  it('delegates to the shared CORS preflight handler', async () => {
    const res = await OPTIONS(makeGetReq() as Parameters<typeof OPTIONS>[0]);
    expect(res.status).toBe(204);
  });
});

describe('POST /api/loops (signed ingest)', () => {
  it('returns 400 for invalid JSON without calling ingestLoopEvent', async () => {
    const req = new Request('https://test.imajin.ai/api/loops', { method: 'POST', body: '{not json' });
    const res = await POST(req as Parameters<typeof POST>[0]);

    expect(res.status).toBe(400);
    expect(mockIngestLoopEvent).not.toHaveBeenCalled();
  });

  it('returns 400 for a malformed envelope without calling ingestLoopEvent (unsigned/malformed rejected before publish)', async () => {
    const res = await POST(makePostReq({ type: 'loop.started' }) as Parameters<typeof POST>[0]);

    expect(res.status).toBe(400);
    expect(mockIngestLoopEvent).not.toHaveBeenCalled();
  });

  it('rejects with the status ingestLoopEvent reports for a forged/unsigned signature', async () => {
    mockIngestLoopEvent.mockResolvedValueOnce({ ok: false, error: 'Invalid publisher signature', status: 400 });

    const res = await POST(makePostReq(validIngestBody()) as Parameters<typeof POST>[0]);
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body).toEqual({ error: 'Invalid publisher signature' });
  });

  it('returns 201 with the loopId on a successfully ingested event', async () => {
    mockIngestLoopEvent.mockResolvedValueOnce({ ok: true });

    const res = await POST(makePostReq(validIngestBody()) as Parameters<typeof POST>[0]);
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body).toEqual({ ok: true, loopId: 'loop_abc123' });
    expect(mockIngestLoopEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'loop.started', publisherDid: 'did:imajin:warp-node' }),
    );
  });
});

describe('GET /api/loops (per-principal list)', () => {
  it('returns 401 without querying when unauthenticated', async () => {
    mockRequireAuth.mockResolvedValueOnce({ error: 'Unauthorized', status: 401 });

    const res = await GET(makeGetReq() as Parameters<typeof GET>[0]);

    expect(res.status).toBe(401);
    expect(mockListLoops).not.toHaveBeenCalled();
  });

  it('scopes the query to the effective (acting) DID, not a caller-supplied principal', async () => {
    mockRequireAuth.mockResolvedValueOnce({ identity: { id: 'did:imajin:agent', actingFor: OPERATOR_DID } });
    mockListLoops.mockResolvedValueOnce([]);

    await GET(makeGetReq() as Parameters<typeof GET>[0]);

    expect(mockListLoops).toHaveBeenCalledWith(expect.objectContaining({ principal: OPERATOR_DID }));
  });

  it('rejects with 403 when ?principal= does not match the effective DID', async () => {
    mockRequireAuth.mockResolvedValueOnce({ identity: { id: OPERATOR_DID } });

    const res = await GET(makeGetReq('?principal=did:imajin:someone-else') as Parameters<typeof GET>[0]);

    expect(res.status).toBe(403);
    expect(mockListLoops).not.toHaveBeenCalled();
  });

  it('passes state/kind/since/ancestor/limit query params through', async () => {
    mockRequireAuth.mockResolvedValueOnce({ identity: { id: OPERATOR_DID } });
    mockListLoops.mockResolvedValueOnce([]);

    await GET(
      makeGetReq('?state=blocked&kind=review&since=2026-09-01T00:00:00.000Z&ancestor=loop_root&limit=10') as Parameters<typeof GET>[0],
    );

    expect(mockListLoops).toHaveBeenCalledWith({
      principal: OPERATOR_DID,
      state: 'blocked',
      kind: 'review',
      since: '2026-09-01T00:00:00.000Z',
      ancestor: 'loop_root',
      limit: 10,
    });
  });

  it('returns the loops the query lib resolves', async () => {
    mockRequireAuth.mockResolvedValueOnce({ identity: { id: OPERATOR_DID } });
    mockListLoops.mockResolvedValueOnce([{ loopId: 'loop_1' }]);

    const res = await GET(makeGetReq() as Parameters<typeof GET>[0]);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ loops: [{ loopId: 'loop_1' }] });
  });
});
