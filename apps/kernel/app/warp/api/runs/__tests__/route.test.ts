/**
 * Tests for GET /warp/api/runs (#1639).
 *
 * The listing is scoped by the *credential*, not by a filter, so what these pin
 * is that the acting DID is always what the read is performed as, and that the
 * query string is translated faithfully — a dropped filter here would silently
 * widen a page rather than fail it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ───────────────────────────────────────────────────────────────────

const { mockRequireAuth } = vi.hoisted(() => ({ mockRequireAuth: vi.fn() }));

vi.mock('@imajin/auth', () => ({
  requireAuth: mockRequireAuth,
  resolveActingDid: (identity: { id: string }) => identity.id,
}));

vi.mock('@/src/lib/kernel/cors', () => ({
  corsHeaders: () => ({ 'Access-Control-Allow-Origin': 'https://app.imajin.ai' }),
  corsOptions: () => new Response(null, { status: 204 }),
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

vi.mock('@/src/lib/warp/dispatch', () => ({
  listAgentRuns: vi.fn(),
}));

import { GET, OPTIONS } from '../route';
import { listAgentRuns } from '@/src/lib/warp/dispatch';
import { WarpApiError } from '@/src/lib/warp/errors';
import { makeAgentRun } from '@/src/lib/warp/__tests__/run-fixture';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const OWNER_DID = 'did:imajin:veteze';
const PAGE = {
  runs: [makeAgentRun({ runId: 'run-1' })],
  hasNextPage: true,
  nextCursor: 'cursor-2',
};

type RouteRequest = Parameters<typeof GET>[0];

function makeReq(query = ''): RouteRequest {
  return {
    headers: new Headers(),
    url: `https://kernel.test/warp/api/runs${query}`,
  } as unknown as RouteRequest;
}

/** Filters the route derived from the query string. */
function filters(): Record<string, unknown> {
  const call = vi.mocked(listAgentRuns).mock.calls.at(-1);
  return (call?.[1] ?? {}) as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireAuth.mockResolvedValue({ identity: { id: OWNER_DID } });
  vi.mocked(listAgentRuns).mockResolvedValue(PAGE);
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('GET /warp/api/runs', () => {
  it('returns 401 without a lookup when unauthenticated', async () => {
    mockRequireAuth.mockResolvedValueOnce({ error: 'Unauthorized', status: 401 });

    const res = await GET(makeReq());

    expect(res.status).toBe(401);
    expect(listAgentRuns).not.toHaveBeenCalled();
  });

  it('lists as the acting DID and returns the page plus its cursor', async () => {
    const res = await GET(makeReq());

    expect(listAgentRuns).toHaveBeenCalledWith(OWNER_DID, {});
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ hasNextPage: true, nextCursor: 'cursor-2' });
  });

  it('forwards every documented filter', async () => {
    await GET(
      makeReq(
        '?name=veteze-jin&state=QUEUED&state=INPROGRESS' +
          '&environmentId=ENVUID&createdAfter=2026-08-01T00:00:00Z&cursor=c1' +
          '&ancestorRunId=run-ancestor-1&limit=50',
      ),
    );

    expect(filters()).toEqual({
      name: 'veteze-jin',
      states: ['QUEUED', 'INPROGRESS'],
      environmentId: 'ENVUID',
      createdAfter: '2026-08-01T00:00:00Z',
      cursor: 'c1',
      ancestorRunId: 'run-ancestor-1',
      limit: 50,
    });
  });

  it('drops a blank or unparseable filter rather than forwarding an empty one', async () => {
    await GET(makeReq('?name=%20%20&state=&limit=abc'));

    expect(filters()).toEqual({});
  });

  it('returns 403 when the caller holds no warp:dispatch grant', async () => {
    vi.mocked(listAgentRuns).mockRejectedValueOnce(new Error('warp_no_grant: nope'));

    const res = await GET(makeReq());

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'warp_no_grant' });
  });

  it('maps an upstream failure through the shared error mapping', async () => {
    vi.mocked(listAgentRuns).mockRejectedValueOnce(
      new WarpApiError('warp_api_error: 429 Too many requests', {
        status: 429,
        retryable: true,
      }),
    );

    const res = await GET(makeReq());

    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ retryable: true });
  });

  it('carries the CORS headers and answers pre-flight', async () => {
    const res = await GET(makeReq());
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://app.imajin.ai');

    expect((await OPTIONS(makeReq())).status).toBe(204);
  });
});
