/**
 * Tests for GET /warp/api/runs/{runId}/transcript (#1639).
 *
 * The route exists because the upstream download is auth-gated, so the thing
 * worth pinning is that it proxies the *content* and never the pre-signed URL,
 * and that it is read as the acting DID like every other Warp route.
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
  getAgentRunTranscript: vi.fn(),
}));

import { GET, OPTIONS } from '../route';
import { getAgentRunTranscript } from '@/src/lib/warp/dispatch';
import { WarpApiError } from '@/src/lib/warp/errors';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const OWNER_DID = 'did:imajin:veteze';
const RUN_ID = '019f9990-2a46-7552-b177-3a23b17eef2e';
const TRANSCRIPT = {
  runId: RUN_ID,
  content: 'user: go\nassistant: done',
  contentType: 'text/plain',
  truncated: false,
};

type RouteRequest = Parameters<typeof GET>[0];

function makeReq(query = ''): RouteRequest {
  return {
    headers: new Headers(),
    url: `https://kernel.test/warp/api/runs/${RUN_ID}/transcript${query}`,
  } as unknown as RouteRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireAuth.mockResolvedValue({ identity: { id: OWNER_DID } });
  vi.mocked(getAgentRunTranscript).mockResolvedValue(TRANSCRIPT);
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('GET /warp/api/runs/{runId}/transcript', () => {
  it('returns 401 without a read when unauthenticated', async () => {
    mockRequireAuth.mockResolvedValueOnce({ error: 'Unauthorized', status: 401 });

    const res = await GET(makeReq(), { params: { runId: RUN_ID } });

    expect(res.status).toBe(401);
    expect(getAgentRunTranscript).not.toHaveBeenCalled();
  });

  it('reads the transcript as the acting DID and returns the content', async () => {
    const res = await GET(makeReq(), { params: { runId: RUN_ID } });

    expect(getAgentRunTranscript).toHaveBeenCalledWith(OWNER_DID, RUN_ID, {});
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      runId: RUN_ID,
      content: TRANSCRIPT.content,
      truncated: false,
    });
  });

  it('never exposes a download URL for the transcript', async () => {
    const res = await GET(makeReq(), { params: { runId: RUN_ID } });
    const body = (await res.json()) as Record<string, unknown>;

    expect(body).not.toHaveProperty('downloadUrl');
    expect(body).not.toHaveProperty('location');
  });

  it('forwards a maxChars cap and ignores a nonsensical one', async () => {
    await GET(makeReq('?maxChars=1000'), { params: { runId: RUN_ID } });
    expect(getAgentRunTranscript).toHaveBeenLastCalledWith(OWNER_DID, RUN_ID, { maxChars: 1000 });

    await GET(makeReq('?maxChars=-5'), { params: { runId: RUN_ID } });
    expect(getAgentRunTranscript).toHaveBeenLastCalledWith(OWNER_DID, RUN_ID, {});
  });

  it('returns 400 for a blank run id', async () => {
    const res = await GET(makeReq(), { params: { runId: '  ' } });

    expect(res.status).toBe(400);
    expect(getAgentRunTranscript).not.toHaveBeenCalled();
  });

  it('returns 403 when the caller holds no warp:dispatch grant', async () => {
    vi.mocked(getAgentRunTranscript).mockRejectedValueOnce(new Error('warp_no_grant: nope'));

    const res = await GET(makeReq(), { params: { runId: RUN_ID } });

    expect(res.status).toBe(403);
  });

  it('maps a run with no transcript to the status Warp reported', async () => {
    vi.mocked(getAgentRunTranscript).mockRejectedValueOnce(
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
