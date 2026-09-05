/**
 * Tests for POST /warp/api/dispatch (#1428).
 *
 * The dispatch client is mocked — its wire behaviour is covered in
 * `src/lib/warp/__tests__/dispatch.test.ts`. What this pins is the route
 * contract: authentication, body validation, that the run is always dispatched as
 * the *acting* DID rather than anything the body claims, and that failures map to
 * actionable statuses without leaking the sealed key.
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
  dispatchAgentRun: vi.fn(),
  watchRun: vi.fn(),
}));

import { POST, OPTIONS } from '../route';
import { dispatchAgentRun, watchRun } from '@/src/lib/warp/dispatch';
import { WarpApiError } from '@/src/lib/warp/errors';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const OWNER_DID = 'did:imajin:veteze';
const AGENT_KEY = 'warp-agent-key-SUPER-SECRET-VALUE';
const RUN = {
  runId: '019f9990-2a46-7552-b177-3a23b17eef2e',
  state: 'QUEUED',
  sessionLink: 'https://app.warp.dev/session/abc',
  title: null,
  configName: 'veteze-jin',
};

type RouteRequest = Parameters<typeof POST>[0];

function makeReq(body: unknown, opts: { rawBody?: string } = {}): RouteRequest {
  return {
    headers: new Headers(),
    json: async () => {
      if (opts.rawBody !== undefined) throw new Error('invalid json');
      return body;
    },
  } as unknown as RouteRequest;
}

/** The input the dispatch client was called with. */
function dispatchInput(): Record<string, unknown> {
  return vi.mocked(dispatchAgentRun).mock.calls[0][1] as unknown as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireAuth.mockResolvedValue({ identity: { id: OWNER_DID } });
  vi.mocked(dispatchAgentRun).mockResolvedValue(RUN);
  vi.mocked(watchRun).mockResolvedValue(undefined);
});

// ─── Auth ────────────────────────────────────────────────────────────────────

describe('authentication', () => {
  it('returns 401 without dispatching when unauthenticated', async () => {
    mockRequireAuth.mockResolvedValueOnce({ error: 'Unauthorized', status: 401 });

    const res = await POST(makeReq({ prompt: 'go' }));

    expect(res.status).toBe(401);
    expect(dispatchAgentRun).not.toHaveBeenCalled();
  });

  it('dispatches as the acting DID, never one named in the body', async () => {
    await POST(makeReq({ prompt: 'go', principalDid: 'did:imajin:someone-else' }));

    expect(vi.mocked(dispatchAgentRun).mock.calls[0][0]).toBe(OWNER_DID);
  });

  it('answers CORS pre-flight', async () => {
    const res = await OPTIONS(makeReq({}));
    expect(res.status).toBe(204);
  });
});

// ─── Body validation ─────────────────────────────────────────────────────────

describe('body validation', () => {
  it('returns 400 on malformed JSON', async () => {
    const res = await POST(makeReq(undefined, { rawBody: 'not json' }));

    expect(res.status).toBe(400);
    expect(dispatchAgentRun).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', {}],
    ['blank', { prompt: '   ' }],
    ['non-string', { prompt: 42 }],
  ])('returns 400 when the prompt is %s', async (_label, body) => {
    const res = await POST(makeReq(body));

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'prompt must be a non-empty string' });
    expect(dispatchAgentRun).not.toHaveBeenCalled();
  });

  it('trims the prompt before dispatching', async () => {
    await POST(makeReq({ prompt: '  go  ' }));
    expect(dispatchInput().prompt).toBe('go');
  });

  it('forwards the optional config surface', async () => {
    await POST(
      makeReq({
        prompt: 'go',
        title: 'Nightly',
        name: 'nightly-check',
        modelId: 'auto',
        basePrompt: 'be brief',
        environmentId: 'UA17BXYZ',
        conversationId: 'conv-123',
        parentRunId: 'run-parent-1',
        skillSpec: 'ima-jin/imajin-ai:catalyst',
        mcpServers: { imajin: { url: 'https://mcp.example/mcp' } },
        attachImajinMcp: true,
        computerUseEnabled: false,
      }),
    );

    expect(dispatchInput()).toEqual({
      prompt: 'go',
      title: 'Nightly',
      name: 'nightly-check',
      modelId: 'auto',
      basePrompt: 'be brief',
      environmentId: 'UA17BXYZ',
      conversationId: 'conv-123',
      parentRunId: 'run-parent-1',
      skillSpec: 'ima-jin/imajin-ai:catalyst',
      mcpServers: { imajin: { url: 'https://mcp.example/mcp' } },
      attachImajinMcp: true,
      computerUseEnabled: false,
    });
  });

  it('omits conversationId/parentRunId when neither is given (#1939)', async () => {
    await POST(makeReq({ prompt: 'go' }));

    expect(dispatchInput()).not.toHaveProperty('conversationId');
    expect(dispatchInput()).not.toHaveProperty('parentRunId');
  });

  it('drops malformed optional fields instead of forwarding junk', async () => {
    await POST(
      makeReq({
        prompt: 'go',
        title: 42,
        skillSpec: '',
        mcpServers: ['not-a-map'],
        attachImajinMcp: 'yes',
      }),
    );

    expect(dispatchInput()).toEqual({ prompt: 'go' });
  });
});

// ─── Success ─────────────────────────────────────────────────────────────────

describe('successful dispatch', () => {
  it('returns 201 with the run id, state, and session link', async () => {
    const res = await POST(makeReq({ prompt: 'go' }));

    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      runId: RUN.runId,
      state: 'QUEUED',
      sessionLink: RUN.sessionLink,
    });
  });

  it('carries the CORS headers', async () => {
    const res = await POST(makeReq({ prompt: 'go' }));
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://app.imajin.ai');
  });
});

// ─── Completion watch (#1639) ─────────────────────────────────────────────

describe('background completion watch', () => {
  it('watches the dispatched run as the acting DID', async () => {
    await POST(makeReq({ prompt: 'go' }));

    expect(watchRun).toHaveBeenCalledWith(OWNER_DID, RUN.runId);
  });

  it('never blocks the response on the watch, which runs for up to 30 minutes', async () => {
    // A watch that never settles: if the route awaited it, this would hang.
    vi.mocked(watchRun).mockReturnValue(new Promise<void>(() => {}));

    const res = await POST(makeReq({ prompt: 'go' }));

    expect(res.status).toBe(201);
  });

  it('does not watch anything when the dispatch itself failed', async () => {
    vi.mocked(dispatchAgentRun).mockRejectedValueOnce(new Error('warp_no_grant: nope'));

    await POST(makeReq({ prompt: 'go' }));

    expect(watchRun).not.toHaveBeenCalled();
  });
});

// ─── Corpus context body validation (#2021) ────────────────────────────

describe('corpusContext body validation', () => {
  it('omits corpusContext entirely when the caller names none', async () => {
    await POST(makeReq({ prompt: 'go' }));
    expect(dispatchInput()).not.toHaveProperty('corpusContext');
  });

  it('forwards a well-formed corpusContext', async () => {
    await POST(
      makeReq({
        prompt: 'go',
        corpusContext: { source: 'github:ima-jin/imajin-ai', query: 'login error', ref: 'deadbeef', limit: 5, maxChars: 2000 },
      }),
    );

    expect(dispatchInput().corpusContext).toEqual({
      source: 'github:ima-jin/imajin-ai',
      query: 'login error',
      ref: 'deadbeef',
      limit: 5,
      maxChars: 2000,
    });
  });

  it('returns 400 without dispatching when corpusContext is not an object', async () => {
    const res = await POST(makeReq({ prompt: 'go', corpusContext: 'nope' }));

    expect(res.status).toBe(400);
    expect(dispatchAgentRun).not.toHaveBeenCalled();
  });

  it.each([
    ['missing source', { query: 'q' }],
    ['missing query', { source: 's' }],
    ['blank source', { source: '   ', query: 'q' }],
  ])('returns 400 without dispatching when corpusContext has %s', async (_label, corpusContext) => {
    const res = await POST(makeReq({ prompt: 'go', corpusContext }));

    expect(res.status).toBe(400);
    expect(dispatchAgentRun).not.toHaveBeenCalled();
  });

  it('clamps an out-of-range limit rather than rejecting the request', async () => {
    await POST(makeReq({ prompt: 'go', corpusContext: { source: 's', query: 'q', limit: 500 } }));
    expect((dispatchInput().corpusContext as { limit: number }).limit).toBe(20);
  });

  it('never lets corpusContext carry a caller-supplied DID through to dispatch (#2021)', async () => {
    await POST(
      makeReq({
        prompt: 'go',
        corpusContext: { source: 's', query: 'q', did: 'did:imajin:someone-else' },
      }),
    );

    expect(dispatchInput().corpusContext).not.toHaveProperty('did');
    // The route always dispatches as the acting DID regardless (see the
    // 'authentication' describe block above); this pins that corpusContext
    // specifically has no back door around that.
    expect(vi.mocked(dispatchAgentRun).mock.calls[0][0]).toBe(OWNER_DID);
  });
});

// ── Failure mapping ────────────────────────────────────────────────────────────────────

describe('failure mapping', () => {
  it('returns 403 when the caller holds no warp:dispatch grant', async () => {
    vi.mocked(dispatchAgentRun).mockRejectedValueOnce(new Error('warp_no_grant: nope'));

    const res = await POST(makeReq({ prompt: 'go' }));

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'warp_no_grant' });
  });

  it('maps a corpus_context_failed error to its own status and body (#2021)', async () => {
    const { CorpusContextError } = await import('@/src/lib/warp/corpus-context');
    vi.mocked(dispatchAgentRun).mockRejectedValueOnce(
      new CorpusContextError('corpus_context_failed: 401 bad claim', 401, 400),
    );

    const res = await POST(makeReq({ prompt: 'go', corpusContext: { source: 's', query: 'q' } }));

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'corpus_context_failed', corpusStatus: 401 });
  });

  it('returns 409 when no key is sealed or the grant was revoked', async () => {
    vi.mocked(dispatchAgentRun).mockRejectedValueOnce(new Error('warp_no_secret: nothing sealed'));

    const res = await POST(makeReq({ prompt: 'go' }));

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'warp_no_secret' });
  });

  it('surfaces an upstream problem document without inventing our own status', async () => {
    vi.mocked(dispatchAgentRun).mockRejectedValueOnce(
      new WarpApiError('warp_api_error: 402 Insufficient credits', {
        status: 402,
        code: 'insufficient_credits',
      }),
    );

    const res = await POST(makeReq({ prompt: 'go' }));

    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({
      error: 'warp_upstream_error',
      code: 'insufficient_credits',
    });
  });

  it('never leaks the sealed key when an unexpected error carries it', async () => {
    vi.mocked(dispatchAgentRun).mockRejectedValueOnce(
      new Error(`kaboom with Bearer ${AGENT_KEY} in the message`),
    );

    const res = await POST(makeReq({ prompt: 'go' }));

    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain(AGENT_KEY);
  });
});
