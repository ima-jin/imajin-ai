/**
 * Tests for POST /profile/api/profile/:id/stream (#1956).
 *
 * The route's auth/trust/brain-resolution gates mirror the sibling `/query`
 * route exactly (see its own test suite, `../../query/__tests__/route.test.ts`,
 * for that coverage — #1621). This suite focuses on what is unique to the
 * streaming path: the `onFinish` usage.incurred emission, fired once per
 * served query with the final token counts, fail-open so a ledger hiccup can
 * never block or alter the SSE stream already served to the caller.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Mocks ───────────────────────────────────────────────────────────────────

const {
  mockRequireAuth,
  mockFindFirst,
  mockInsertValues,
  mockResolveBrain,
  mockGetModel,
  mockStreamText,
  mockCalculateCost,
} = vi.hoisted(() => ({
  mockRequireAuth: vi.fn(),
  mockFindFirst: vi.fn(),
  mockInsertValues: vi.fn(),
  mockResolveBrain: vi.fn(),
  mockGetModel: vi.fn(),
  mockStreamText: vi.fn(),
  mockCalculateCost: vi.fn(),
}));

vi.mock('@/src/db', () => ({
  db: {
    query: { profiles: { findFirst: mockFindFirst } },
    insert: () => ({ values: mockInsertValues }),
  },
  queryLogs: {},
}));

vi.mock('@imajin/auth', () => ({ requireAuth: mockRequireAuth }));

vi.mock('ai', () => ({ streamText: mockStreamText }));

vi.mock('@imajin/llm', () => ({
  getModel: mockGetModel,
  calculateCost: mockCalculateCost,
  createPresenceTools: () => ({}),
}));

// See the `/query` route's own test suite for why this must be a real,
// hoisted class rather than a plain mock object.
const { NoBrainSealedError } = vi.hoisted(() => {
  class NoBrainSealedError extends Error {
    readonly failures: readonly { connector: string; credentialDid: string; cause: string }[];
    constructor(
      ownerDid: string,
      failures: readonly { connector: string; credentialDid: string; cause: string }[] = [],
    ) {
      super(`inference_no_brain: DID ${ownerDid} has no model credential sealed`);
      this.name = 'NoBrainSealedError';
      this.failures = failures;
    }
  }
  return { NoBrainSealedError };
});

vi.mock('@/src/lib/inference/brain', () => ({
  resolveBrain: mockResolveBrain,
  NoBrainSealedError,
}));

vi.mock('nanoid', () => ({ nanoid: () => 'query_1' }));
vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('@imajin/config', () => ({ buildPublicUrl: () => 'https://imajin.test/profile' }));

const { mockRecordPresenceQueryUsage } = vi.hoisted(() => ({
  mockRecordPresenceQueryUsage: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/src/lib/inference/presence-query-usage', () => ({
  recordPresenceQueryUsage: mockRecordPresenceQueryUsage,
  PRESENCE_QUERY_SOURCE: 'presence:query',
}));

import { POST } from '../route';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const OWNER_DID = 'did:imajin:presence-owner';
const REQUESTER_DID = 'did:imajin:presence-owner'; // self-query: skips the trust hop
const OWNER_KEY = 'sk-ant-OWNER-SEALED';

const BRAIN = {
  connector: 'anthropic' as const,
  provider: 'anthropic' as const,
  modelId: 'claude-sonnet-4-20250514',
  apiKey: OWNER_KEY,
};

type RouteArgs = Parameters<typeof POST>;

function makeReq(body: unknown = { message: 'hello' }): RouteArgs[0] {
  return { json: async () => body, headers: new Headers() } as unknown as RouteArgs[0];
}

const params = { params: Promise.resolve({ id: OWNER_DID }) } as unknown as RouteArgs[1];

/** Minimal shape the route's `for await (const part of result.fullStream)` loop needs. */
async function* fakeFullStream(): AsyncGenerator<{ type: string; textDelta?: string }> {
  yield { type: 'text-delta', textDelta: 'hi' };
}

type OnFinishArg = { usage: { promptTokens: number; completionTokens: number }; steps: unknown[] };

/**
 * Captures the `onFinish` callback the route registers with `streamText`, so
 * tests can fire it directly — the mocked `streamText` below never calls it
 * itself (unlike the real `ai` package, which invokes it once the model
 * finishes generating).
 */
function captureOnFinish(): (arg: OnFinishArg) => Promise<void> {
  const call = mockStreamText.mock.calls[mockStreamText.mock.calls.length - 1][0];
  return call.onFinish;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireAuth.mockResolvedValue({ identity: { id: REQUESTER_DID } });
  mockFindFirst.mockResolvedValue({
    did: OWNER_DID,
    displayName: 'Owner',
    featureToggles: { inference_enabled: true },
  });
  mockResolveBrain.mockResolvedValue(BRAIN);
  mockGetModel.mockReturnValue({});
  mockStreamText.mockReturnValue({ fullStream: fakeFullStream() });
  mockCalculateCost.mockReturnValue(0);
  mockInsertValues.mockResolvedValue(undefined);
  mockRecordPresenceQueryUsage.mockResolvedValue(undefined);
  // No presence document — the route falls back to a default system prompt.
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }));
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ─── usage.incurred emission (#1956) ──────────────────────────────────────────

describe('presence stream — usage.incurred emission (#1956)', () => {
  it('emits exactly one usage.incurred row on completion, with the final token counts', async () => {
    const res = await POST(makeReq(), params);
    expect(res.status).toBe(200);

    const onFinish = captureOnFinish();
    await onFinish({ usage: { promptTokens: 20, completionTokens: 8 }, steps: [] });

    expect(mockRecordPresenceQueryUsage).toHaveBeenCalledTimes(1);
    expect(mockRecordPresenceQueryUsage).toHaveBeenCalledWith({
      queryId: 'query_1',
      mode: 'stream',
      actingForDid: OWNER_DID,
      requesterDid: REQUESTER_DID,
      provider: 'anthropic',
      modelId: 'claude-sonnet-4-20250514',
      promptTokens: 20,
      completionTokens: 8,
      costUsd: 0,
      settled: false,
      settleAmount: 0,
    });
  });

  it('carries the resolved owner brain\'s connector as the resource provider, not the requester\'s', async () => {
    mockResolveBrain.mockResolvedValueOnce({
      ...BRAIN,
      connector: 'gemini',
      provider: 'openai',
      modelId: 'gemini-2.0-flash',
    });

    await POST(makeReq(), params);
    const onFinish = captureOnFinish();
    await onFinish({ usage: { promptTokens: 1, completionTokens: 1 }, steps: [] });

    expect(mockRecordPresenceQueryUsage).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'gemini', modelId: 'gemini-2.0-flash' }),
    );
  });

  it('reports settled + settleAmount when the query was actually settled', async () => {
    mockRequireAuth.mockResolvedValueOnce({ identity: { id: 'did:imajin:someone-else' } });
    mockCalculateCost.mockReturnValueOnce(0.05);
    vi.stubEnv('PAY_SERVICE_URL', 'https://pay.test');
    vi.stubEnv('PAY_SERVICE_API_KEY', 'pay-key');
    vi.stubEnv('PLATFORM_DID', 'did:imajin:platform');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ connected: true, distance: 1 }) }) // trust
      .mockResolvedValueOnce({ ok: false, json: async () => ({}) }) // presence doc
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) }); // settle
    vi.stubGlobal('fetch', fetchMock);

    await POST(makeReq(), params);
    const onFinish = captureOnFinish();
    await onFinish({ usage: { promptTokens: 4, completionTokens: 2 }, steps: [] });

    expect(mockRecordPresenceQueryUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        settled: true,
        settleAmount: 0.05,
        costUsd: 0.05,
        requesterDid: 'did:imajin:someone-else',
      }),
    );
  });

  it('emits only once per query even when onFinish reports multiple steps', async () => {
    await POST(makeReq(), params);
    const onFinish = captureOnFinish();

    await onFinish({ usage: { promptTokens: 5, completionTokens: 3 }, steps: [{}, {}, {}] });

    expect(mockRecordPresenceQueryUsage).toHaveBeenCalledTimes(1);
  });

  it('never lets a ledger failure block or alter the SSE stream already served', async () => {
    mockRecordPresenceQueryUsage.mockRejectedValueOnce(new Error('ledger unavailable'));

    const res = await POST(makeReq(), params);
    expect(res.status).toBe(200);

    const onFinish = captureOnFinish();
    await expect(
      onFinish({ usage: { promptTokens: 1, completionTokens: 1 }, steps: [] }),
    ).resolves.toBeUndefined();

    const text = await res.text();
    expect(text).toContain('"type":"text"');
    expect(text).toContain('"type":"done"');
  });
});
