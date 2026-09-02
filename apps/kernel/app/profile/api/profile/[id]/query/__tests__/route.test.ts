/**
 * Tests for POST /profile/api/profile/:id/query (#1621).
 *
 * A presence speaks on its owner's behalf, so it must run on the OWNER's sealed
 * brain — not the requester's, and not a shared node env key. These pin that,
 * plus the two new failure modes introduced when the env fallback was removed:
 * no sealed brain (409) and a resolver fault (503).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Mocks ───────────────────────────────────────────────────────────────────

const {
  mockRequireAuth,
  mockFindFirst,
  mockInsertValues,
  mockResolveBrain,
  mockGetModel,
  mockGenerateText,
  mockCalculateCost,
} = vi.hoisted(() => ({
  mockRequireAuth: vi.fn(),
  mockFindFirst: vi.fn(),
  mockInsertValues: vi.fn(),
  mockResolveBrain: vi.fn(),
  mockGetModel: vi.fn(),
  mockGenerateText: vi.fn(),
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

vi.mock('ai', () => ({ generateText: mockGenerateText }));

vi.mock('@imajin/llm', () => ({
  getModel: mockGetModel,
  calculateCost: mockCalculateCost,
  createPresenceTools: () => ({}),
}));

// NoBrainSealedError must be a real class so the route's `instanceof` branch
// works, and it must be hoisted: vi.mock factories run before module-level
// declarations are initialised.
//
// `failures` mirrors the real shape (#1637): empty means "the owner genuinely
// connected nothing", which is the 409 the tests below assert. A non-empty
// `failures` means the walk was degraded by a throwing connector and maps to 503
// instead.
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
  mockGenerateText.mockResolvedValue({
    text: 'an answer',
    usage: { promptTokens: 10, completionTokens: 5 },
  });
  mockCalculateCost.mockReturnValue(0);
  mockInsertValues.mockResolvedValue(undefined);
  mockRecordPresenceQueryUsage.mockResolvedValue(undefined);
  // No presence document — the route falls back to a default system prompt.
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }));
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ─── Owner-brain resolution ──────────────────────────────────────────────────

describe('presence query — runs on the owner\'s sealed brain (#1621)', () => {
  it('resolves the brain for the presence owner, not the requester', async () => {
    mockRequireAuth.mockResolvedValueOnce({ identity: { id: 'did:imajin:someone-else' } });
    // A different requester would need the trust hop; make it pass.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ connected: true, distance: 1 }),
    }));

    await POST(makeReq(), params);

    expect(mockResolveBrain).toHaveBeenCalledWith(OWNER_DID);
  });

  it('passes the owner\'s sealed credential to the model factory', async () => {
    await POST(makeReq(), params);

    expect(mockGetModel).toHaveBeenCalledWith('anthropic', 'claude-sonnet-4-20250514', {
      apiKey: OWNER_KEY,
    });
  });

  it('forwards a sealed baseURL when the owner sealed one', async () => {
    mockResolveBrain.mockResolvedValueOnce({
      ...BRAIN,
      connector: 'gemini',
      provider: 'openai',
      modelId: 'gemini-2.0-flash',
      baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
    });

    await POST(makeReq(), params);

    expect(mockGetModel).toHaveBeenCalledWith('openai', 'gemini-2.0-flash', {
      apiKey: OWNER_KEY,
      baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
    });
  });

  it('bills against the resolved model, not a vocab-declared one', async () => {
    mockCalculateCost.mockReturnValueOnce(0);

    const res = await POST(makeReq(), params);

    expect(mockCalculateCost).toHaveBeenCalledWith('claude-sonnet-4-20250514', 10, 5);
    expect(await res.json()).toMatchObject({ model: 'claude-sonnet-4-20250514' });
  });

  it('never returns the owner credential in the response', async () => {
    const res = await POST(makeReq(), params);

    expect(JSON.stringify(await res.json())).not.toContain(OWNER_KEY);
  });
});

// ─── Failure modes introduced by removing the env fallback ───────────────────

describe('presence query — no env fallback', () => {
  it('returns 409 when the owner has sealed no brain', async () => {
    mockResolveBrain.mockRejectedValueOnce(new NoBrainSealedError(OWNER_DID));

    const res = await POST(makeReq(), params);

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'This profile has not connected a model for inference',
    });
    expect(mockGenerateText).not.toHaveBeenCalled();
  });

  it('returns 503 when brain resolution faults for another reason', async () => {
    mockResolveBrain.mockRejectedValueOnce(new Error('vault unavailable'));

    const res = await POST(makeReq(), params);

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Inference unavailable' });
  });

  /**
   * A connector that threw is skipped rather than aborting resolution (#1637),
   * so "no brain" can now mean "a card exists but could not be read". That is a
   * retryable fault, not the owner failing to connect anything, and it must not
   * be reported as the actionable 409.
   */
  it('returns 503 when the walk was degraded by a failing connector', async () => {
    mockResolveBrain.mockRejectedValueOnce(
      new NoBrainSealedError(OWNER_DID, [
        { connector: 'gemini', credentialDid: OWNER_DID, cause: 'VaultDelegationError' },
      ]),
    );

    const res = await POST(makeReq(), params);

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Inference unavailable' });
  });

  it('does not leak the resolver failure detail to the caller', async () => {
    mockResolveBrain.mockRejectedValueOnce(new Error(`vault said ${OWNER_KEY}`));

    const res = await POST(makeReq(), params);

    expect(JSON.stringify(await res.json())).not.toContain(OWNER_KEY);
  });
});

// ─── Gates that must run before any brain is resolved ────────────────────────

describe('presence query — gates', () => {
  it('rejects an unauthenticated caller before resolving a brain', async () => {
    mockRequireAuth.mockResolvedValueOnce({ error: 'Unauthorized', status: 401 });

    const res = await POST(makeReq(), params);

    expect(res.status).toBe(401);
    expect(mockResolveBrain).not.toHaveBeenCalled();
  });

  it('404s an unknown profile without resolving a brain', async () => {
    mockFindFirst.mockResolvedValueOnce(undefined);

    const res = await POST(makeReq(), params);

    expect(res.status).toBe(404);
    expect(mockResolveBrain).not.toHaveBeenCalled();
  });

  it('403s when the profile has not enabled inference', async () => {
    mockFindFirst.mockResolvedValueOnce({
      did: OWNER_DID,
      displayName: 'Owner',
      featureToggles: { inference_enabled: false },
    });

    const res = await POST(makeReq(), params);

    expect(res.status).toBe(403);
    expect(mockResolveBrain).not.toHaveBeenCalled();
  });

  it('400s a request with no message', async () => {
    const res = await POST(makeReq({}), params);

    expect(res.status).toBe(400);
    expect(mockGenerateText).not.toHaveBeenCalled();
  });
});

// ─── usage.incurred emission (#1956) ──────────────────────────────────────────

describe('presence query — usage.incurred emission (#1956)', () => {
  it('emits exactly one usage.incurred row per served query, with the shared field shape', async () => {
    const res = await POST(makeReq(), params);

    expect(res.status).toBe(200);
    expect(mockRecordPresenceQueryUsage).toHaveBeenCalledTimes(1);
    expect(mockRecordPresenceQueryUsage).toHaveBeenCalledWith({
      queryId: 'query_1',
      mode: 'query',
      actingForDid: OWNER_DID,
      requesterDid: REQUESTER_DID,
      provider: 'anthropic',
      modelId: 'claude-sonnet-4-20250514',
      promptTokens: 10,
      completionTokens: 5,
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

    expect(mockRecordPresenceQueryUsage).toHaveBeenCalledWith(
      expect.objectContaining({ settled: true, settleAmount: 0.05, costUsd: 0.05 }),
    );
  });

  it('never lets a ledger failure change the HTTP response already computed', async () => {
    mockRecordPresenceQueryUsage.mockRejectedValueOnce(new Error('ledger unavailable'));

    const res = await POST(makeReq(), params);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ response: 'an answer' });
  });
});
