/**
 * Tests for GET /auth/api/retrace (#1962) — auth propagation and mapping
 * `walkRetrace`'s typed errors to HTTP status codes. The walk's own
 * behavior (chain traversal, tombstones, cycle guard) is covered by
 * `src/lib/retrace/__tests__/walk.test.ts`; this file only pins the route
 * boundary.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { requireAuthMock, walkRetraceMock, createDefaultRepositoryMock } = vi.hoisted(() => ({
  requireAuthMock: vi.fn(),
  walkRetraceMock: vi.fn(),
  createDefaultRepositoryMock: vi.fn(() => ({ __repo: true })),
}));

vi.mock('@imajin/auth', () => ({
  requireAuth: requireAuthMock,
  authErrorResponse: (authError: { error: string; status: number }) =>
    new Response(JSON.stringify({ error: authError.error }), { status: authError.status }),
}));

vi.mock('@/src/lib/retrace/repository', () => ({
  identifyArtifactKind: (id: string, explicitKind?: string | null) => explicitKind ?? (id.startsWith('att_') ? 'attestation' : id.startsWith('prov_') ? 'agent_provision' : 'bus_event'),
  createDefaultRepository: createDefaultRepositoryMock,
}));

const { RetraceNotFoundErrorMock, RetraceForbiddenStartErrorMock } = vi.hoisted(() => ({
  RetraceNotFoundErrorMock: class RetraceNotFoundError extends Error {},
  RetraceForbiddenStartErrorMock: class RetraceForbiddenStartError extends Error {},
}));
vi.mock('@/src/lib/retrace/walk', () => ({
  walkRetrace: walkRetraceMock,
  RetraceNotFoundError: RetraceNotFoundErrorMock,
  RetraceForbiddenStartError: RetraceForbiddenStartErrorMock,
}));

vi.mock('@imajin/logger', () => ({ createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }) }));

import { GET } from '../route';

const CALLER = 'did:imajin:ryan';
const BASE = 'http://localhost:3000/auth/api/retrace';

type RouteRequest = Parameters<typeof GET>[0];

function makeRequest(query: string): RouteRequest {
  return new Request(`${BASE}${query}`) as unknown as RouteRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  createDefaultRepositoryMock.mockReturnValue({ __repo: true });
});

describe('GET /auth/api/retrace', () => {
  it('propagates an unauthenticated caller as 401', async () => {
    requireAuthMock.mockResolvedValue({ error: 'Not authenticated', status: 401 });

    const res = await GET(makeRequest('?artifact=att_1'));

    expect(res.status).toBe(401);
    expect(walkRetraceMock).not.toHaveBeenCalled();
  });

  it('returns 400 when artifact is missing', async () => {
    requireAuthMock.mockResolvedValue({ identity: { id: CALLER } });

    const res = await GET(makeRequest(''));

    expect(res.status).toBe(400);
    expect(walkRetraceMock).not.toHaveBeenCalled();
  });

  it('returns 404 for an unknown artifact', async () => {
    requireAuthMock.mockResolvedValue({ identity: { id: CALLER } });
    walkRetraceMock.mockRejectedValue(new RetraceNotFoundErrorMock('not found'));

    const res = await GET(makeRequest('?artifact=att_missing'));

    expect(res.status).toBe(404);
  });

  it('returns 403 when the caller cannot read the starting artifact', async () => {
    requireAuthMock.mockResolvedValue({ identity: { id: CALLER } });
    walkRetraceMock.mockRejectedValue(new RetraceForbiddenStartErrorMock('forbidden'));

    const res = await GET(makeRequest('?artifact=att_1'));

    expect(res.status).toBe(403);
  });

  it('returns 500 for an unexpected error', async () => {
    requireAuthMock.mockResolvedValue({ identity: { id: CALLER } });
    walkRetraceMock.mockRejectedValue(new Error('db exploded'));

    const res = await GET(makeRequest('?artifact=att_1'));

    expect(res.status).toBe(500);
  });

  it('infers the artifact kind from the id prefix and resolves the caller\u2019s effective DID', async () => {
    requireAuthMock.mockResolvedValue({ identity: { id: 'did:imajin:agent', actingAs: CALLER } });
    walkRetraceMock.mockResolvedValue({ hops: [], terminal: { reached: true, ref: null, reason: 'origin' }, truncated: false });

    const res = await GET(makeRequest('?artifact=prov_1'));

    expect(res.status).toBe(200);
    expect(walkRetraceMock).toHaveBeenCalledWith({ kind: 'agent_provision', id: 'prov_1' }, CALLER, { __repo: true });
    expect(await res.json()).toEqual({ hops: [], terminal: { reached: true, ref: null, reason: 'origin' }, truncated: false });
  });

  it('honors an explicit kind override', async () => {
    requireAuthMock.mockResolvedValue({ identity: { id: CALLER } });
    walkRetraceMock.mockResolvedValue({ hops: [], terminal: { reached: false, ref: null, reason: null }, truncated: false });

    await GET(makeRequest('?artifact=some-uuid&kind=bus_event'));

    expect(walkRetraceMock).toHaveBeenCalledWith({ kind: 'bus_event', id: 'some-uuid' }, CALLER, { __repo: true });
  });
});
