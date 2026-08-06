/**
 * Tests for POST /warp/api/runs/{runId}/followups (#1639).
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
  sendFollowup: vi.fn(),
}));

import { POST, OPTIONS } from '../route';
import { sendFollowup } from '@/src/lib/warp/dispatch';
import { WarpApiError } from '@/src/lib/warp/errors';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const OWNER_DID = 'did:imajin:veteze';
const RUN_ID = '019f9990-2a46-7552-b177-3a23b17eef2e';

type RouteRequest = Parameters<typeof POST>[0];

/** A request whose body is `body`, or unparseable JSON when `body` is a string. */
function makeReq(body: unknown = { message: 'use pnpm, not npm' }): RouteRequest {
  return {
    headers: new Headers(),
    json: async () => {
      if (typeof body === 'string') throw new Error('invalid json');
      return body;
    },
  } as unknown as RouteRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireAuth.mockResolvedValue({ identity: { id: OWNER_DID } });
  vi.mocked(sendFollowup).mockResolvedValue({ runId: RUN_ID, accepted: true });
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('POST /warp/api/runs/{runId}/followups', () => {
  it('returns 401 without sending anything when unauthenticated', async () => {
    mockRequireAuth.mockResolvedValueOnce({ error: 'Unauthorized', status: 401 });

    const res = await POST(makeReq(), { params: { runId: RUN_ID } });

    expect(res.status).toBe(401);
    expect(sendFollowup).not.toHaveBeenCalled();
  });

  it('sends the message as the acting DID and answers 202 accepted', async () => {
    const res = await POST(makeReq(), { params: { runId: RUN_ID } });

    expect(sendFollowup).toHaveBeenCalledWith(OWNER_DID, RUN_ID, {
      message: 'use pnpm, not npm',
    });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ runId: RUN_ID, accepted: true });
  });

  it('forwards an explicit mode', async () => {
    await POST(makeReq({ message: 'replan', mode: 'plan' }), { params: { runId: RUN_ID } });

    expect(sendFollowup).toHaveBeenCalledWith(OWNER_DID, RUN_ID, {
      message: 'replan',
      mode: 'plan',
    });
  });

  it('returns 400 for an unparseable body', async () => {
    const res = await POST(makeReq('not json'), { params: { runId: RUN_ID } });

    expect(res.status).toBe(400);
    expect(sendFollowup).not.toHaveBeenCalled();
  });

  it('returns 400 for a missing or blank message', async () => {
    expect((await POST(makeReq({}), { params: { runId: RUN_ID } })).status).toBe(400);
    expect((await POST(makeReq({ message: '  ' }), { params: { runId: RUN_ID } })).status).toBe(400);
    expect(sendFollowup).not.toHaveBeenCalled();
  });

  it('returns 400 for a blank run id', async () => {
    const res = await POST(makeReq(), { params: { runId: '  ' } });

    expect(res.status).toBe(400);
    expect(sendFollowup).not.toHaveBeenCalled();
  });

  it('surfaces an invalid mode as a 400 from the client library rule', async () => {
    vi.mocked(sendFollowup).mockRejectedValueOnce(
      new Error('warp_invalid_mode: mode must be one of normal, plan, orchestrate'),
    );

    const res = await POST(makeReq({ message: 'go', mode: 'yolo' }), {
      params: { runId: RUN_ID },
    });

    expect(res.status).toBe(400);
  });

  it('returns 403 when the caller holds no warp:dispatch grant', async () => {
    vi.mocked(sendFollowup).mockRejectedValueOnce(new Error('warp_no_grant: nope'));

    const res = await POST(makeReq(), { params: { runId: RUN_ID } });

    expect(res.status).toBe(403);
  });

  it('maps an upstream refusal to the status Warp reported', async () => {
    vi.mocked(sendFollowup).mockRejectedValueOnce(
      new WarpApiError('warp_api_error: 404 Not found', {
        status: 404,
        code: 'resource_not_found',
      }),
    );

    const res = await POST(makeReq(), { params: { runId: RUN_ID } });

    expect(res.status).toBe(404);
  });

  it('carries the CORS headers and answers pre-flight', async () => {
    const res = await POST(makeReq(), { params: { runId: RUN_ID } });
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://app.imajin.ai');

    expect((await OPTIONS(makeReq())).status).toBe(204);
  });
});
