/**
 * Tests for POST /warp/api/runs/{runId}/cancel (#1639).
 *
 * Cancel is a mutation on someone else's compute, so the important properties are
 * that it happens as the acting DID and that Warp's three distinct refusals stay
 * distinguishable — "already finished", "not yet, retry", and "never".
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
  cancelAgentRun: vi.fn(),
}));

import { POST, OPTIONS } from '../route';
import { cancelAgentRun } from '@/src/lib/warp/dispatch';
import { WarpApiError } from '@/src/lib/warp/errors';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const OWNER_DID = 'did:imajin:veteze';
const RUN_ID = '019f9990-2a46-7552-b177-3a23b17eef2e';

type RouteRequest = Parameters<typeof POST>[0];

function makeReq(): RouteRequest {
  return { headers: new Headers() } as unknown as RouteRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireAuth.mockResolvedValue({ identity: { id: OWNER_DID } });
  vi.mocked(cancelAgentRun).mockResolvedValue({ runId: RUN_ID, cancelled: true });
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('POST /warp/api/runs/{runId}/cancel', () => {
  it('returns 401 without cancelling anything when unauthenticated', async () => {
    mockRequireAuth.mockResolvedValueOnce({ error: 'Unauthorized', status: 401 });

    const res = await POST(makeReq(), { params: { runId: RUN_ID } });

    expect(res.status).toBe(401);
    expect(cancelAgentRun).not.toHaveBeenCalled();
  });

  it('cancels as the acting DID and confirms', async () => {
    const res = await POST(makeReq(), { params: { runId: RUN_ID } });

    expect(cancelAgentRun).toHaveBeenCalledWith(OWNER_DID, RUN_ID);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ runId: RUN_ID, cancelled: true });
  });

  it('returns 400 for a blank run id', async () => {
    const res = await POST(makeReq(), { params: { runId: '   ' } });

    expect(res.status).toBe(400);
    expect(cancelAgentRun).not.toHaveBeenCalled();
  });

  it('returns 409 with retryable when the run is still PENDING', async () => {
    vi.mocked(cancelAgentRun).mockRejectedValueOnce(
      new WarpApiError('warp_api_error: 409 Conflict', {
        status: 409,
        code: 'conflict',
        retryable: true,
      }),
    );

    const res = await POST(makeReq(), { params: { runId: RUN_ID } });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'conflict', retryable: true });
  });

  it('returns 422 when the run type cannot be cancelled at all', async () => {
    vi.mocked(cancelAgentRun).mockRejectedValueOnce(
      new WarpApiError('warp_api_error: 422 Unsupported', {
        status: 422,
        code: 'operation_not_supported',
      }),
    );

    const res = await POST(makeReq(), { params: { runId: RUN_ID } });

    expect(res.status).toBe(422);
  });

  it('returns 409 with the connector hint when no key is sealed', async () => {
    vi.mocked(cancelAgentRun).mockRejectedValueOnce(new Error('warp_no_secret: nothing sealed'));

    const res = await POST(makeReq(), { params: { runId: RUN_ID } });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'warp_no_secret' });
  });

  it('carries the CORS headers and answers pre-flight', async () => {
    const res = await POST(makeReq(), { params: { runId: RUN_ID } });
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://app.imajin.ai');

    expect((await OPTIONS(makeReq())).status).toBe(204);
  });
});
