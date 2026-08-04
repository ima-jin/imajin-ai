/**
 * Tests for GET /warp/api/runs/{runId} (#1428).
 *
 * The point of this route is that a run is read with the *caller's* own sealed
 * key, so cross-DID reads are structurally impossible rather than checked. These
 * pin that the acting DID is always what gets used, and that the same
 * `warp:dispatch` gate applies to reads as to dispatch.
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
  getAgentRun: vi.fn(),
}));

import { GET, OPTIONS } from '../route';
import { getAgentRun } from '@/src/lib/warp/dispatch';
import { WarpApiError } from '@/src/lib/warp/errors';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const OWNER_DID = 'did:imajin:veteze';
const RUN_ID = '019f9990-2a46-7552-b177-3a23b17eef2e';
const RUN = {
  runId: RUN_ID,
  state: 'SUCCEEDED',
  sessionLink: 'https://app.warp.dev/session/abc',
  title: null,
  configName: 'veteze-jin',
};

type RouteRequest = Parameters<typeof GET>[0];

function makeReq(): RouteRequest {
  return { headers: new Headers() } as unknown as RouteRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireAuth.mockResolvedValue({ identity: { id: OWNER_DID } });
  vi.mocked(getAgentRun).mockResolvedValue(RUN);
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('GET /warp/api/runs/{runId}', () => {
  it('returns 401 without a lookup when unauthenticated', async () => {
    mockRequireAuth.mockResolvedValueOnce({ error: 'Unauthorized', status: 401 });

    const res = await GET(makeReq(), { params: { runId: RUN_ID } });

    expect(res.status).toBe(401);
    expect(getAgentRun).not.toHaveBeenCalled();
  });

  it('reads the run as the acting DID and surfaces state + session link', async () => {
    const res = await GET(makeReq(), { params: { runId: RUN_ID } });

    expect(getAgentRun).toHaveBeenCalledWith(OWNER_DID, RUN_ID);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      runId: RUN_ID,
      state: 'SUCCEEDED',
      sessionLink: RUN.sessionLink,
    });
  });

  it('returns 400 for a blank run id', async () => {
    const res = await GET(makeReq(), { params: { runId: '   ' } });

    expect(res.status).toBe(400);
    expect(getAgentRun).not.toHaveBeenCalled();
  });

  it('returns 403 when the caller holds no warp:dispatch grant', async () => {
    vi.mocked(getAgentRun).mockRejectedValueOnce(new Error('warp_no_grant: nope'));

    const res = await GET(makeReq(), { params: { runId: RUN_ID } });

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'warp_no_grant' });
  });

  it('maps an unknown run upstream to the same status Warp reported', async () => {
    vi.mocked(getAgentRun).mockRejectedValueOnce(
      new WarpApiError('warp_api_error: 404 Not found', {
        status: 404,
        code: 'resource_not_found',
      }),
    );

    const res = await GET(makeReq(), { params: { runId: RUN_ID } });

    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'resource_not_found' });
  });

  it('carries the CORS headers and answers pre-flight', async () => {
    const res = await GET(makeReq(), { params: { runId: RUN_ID } });
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://app.imajin.ai');

    expect((await OPTIONS(makeReq())).status).toBe(204);
  });
});
