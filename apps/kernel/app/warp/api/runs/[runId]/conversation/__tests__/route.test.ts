/**
 * Tests for GET /warp/api/runs/{runId}/conversation (#1639).
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
  getAgentRunConversation: vi.fn(),
}));

import { GET, OPTIONS } from '../route';
import { getAgentRunConversation } from '@/src/lib/warp/dispatch';
import { WarpApiError } from '@/src/lib/warp/errors';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const OWNER_DID = 'did:imajin:veteze';
const RUN_ID = '019f9990-2a46-7552-b177-3a23b17eef2e';
const CONVERSATION = {
  runId: RUN_ID,
  conversationId: 'conversation-uuid',
  steps: [
    {
      id: 'step-1',
      messages: [{ role: 'assistant', content: [{ type: 'text', text: 'done' }] }],
      steps: [],
    },
  ],
};

type RouteRequest = Parameters<typeof GET>[0];

function makeReq(): RouteRequest {
  return { headers: new Headers() } as unknown as RouteRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireAuth.mockResolvedValue({ identity: { id: OWNER_DID } });
  vi.mocked(getAgentRunConversation).mockResolvedValue(CONVERSATION);
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('GET /warp/api/runs/{runId}/conversation', () => {
  it('returns 401 without a read when unauthenticated', async () => {
    mockRequireAuth.mockResolvedValueOnce({ error: 'Unauthorized', status: 401 });

    const res = await GET(makeReq(), { params: { runId: RUN_ID } });

    expect(res.status).toBe(401);
    expect(getAgentRunConversation).not.toHaveBeenCalled();
  });

  it('reads as the acting DID and passes the step tree through untouched', async () => {
    const res = await GET(makeReq(), { params: { runId: RUN_ID } });

    expect(getAgentRunConversation).toHaveBeenCalledWith(OWNER_DID, RUN_ID);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(CONVERSATION);
  });

  it('returns 400 for a blank run id', async () => {
    const res = await GET(makeReq(), { params: { runId: '' } });

    expect(res.status).toBe(400);
    expect(getAgentRunConversation).not.toHaveBeenCalled();
  });

  it('returns 403 when the caller holds no warp:dispatch grant', async () => {
    vi.mocked(getAgentRunConversation).mockRejectedValueOnce(new Error('warp_no_grant: nope'));

    const res = await GET(makeReq(), { params: { runId: RUN_ID } });

    expect(res.status).toBe(403);
  });

  it('passes through the 422 Warp uses for an unsupported conversation format', async () => {
    vi.mocked(getAgentRunConversation).mockRejectedValueOnce(
      new WarpApiError('warp_api_error: 422 Unsupported', {
        status: 422,
        code: 'operation_not_supported',
      }),
    );

    const res = await GET(makeReq(), { params: { runId: RUN_ID } });

    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: 'operation_not_supported' });
  });

  it('carries the CORS headers and answers pre-flight', async () => {
    const res = await GET(makeReq(), { params: { runId: RUN_ID } });
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://app.imajin.ai');

    expect((await OPTIONS(makeReq())).status).toBe(204);
  });
});
