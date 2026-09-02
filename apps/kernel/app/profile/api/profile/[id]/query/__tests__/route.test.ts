/**
 * Tests for POST /profile/api/profile/:id/query (#1621, #1956).
 *
 * A presence speaks on its owner's behalf, so it must run on the OWNER's sealed
 * brain — not the requester's, and not a shared node env key. These pin that,
 * plus the two new failure modes introduced when the env fallback was removed:
 * no sealed brain (409) and a resolver fault (503) — and the #1956
 * usage.incurred emission. Shared vi.mock boilerplate/fixtures with the
 * sibling `/stream` suite live in `../../__tests__/route-test-support`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  mockRequireAuth,
  mockFindFirst,
  mockResolveBrain,
  mockGetModel,
  mockGenerateText,
  mockCalculateCost,
  mockRecordPresenceQueryUsage,
  NoBrainSealedError,
  OWNER_DID,
  REQUESTER_DID,
  OWNER_KEY,
  BRAIN,
  resetPresenceRouteMocks,
  stubSettlementEnv,
  makeSettledFetchMock,
} from '../../__tests__/route-test-support';

import { POST } from '../route';

type RouteArgs = Parameters<typeof POST>;

function makeReq(body: unknown = { message: 'hello' }): RouteArgs[0] {
  return { json: async () => body, headers: new Headers() } as unknown as RouteArgs[0];
}

const params = { params: Promise.resolve({ id: OWNER_DID }) } as unknown as RouteArgs[1];

beforeEach(() => {
  resetPresenceRouteMocks();
  mockGenerateText.mockResolvedValue({
    text: 'an answer',
    usage: { promptTokens: 10, completionTokens: 5 },
  });
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

  it('reports settled=true with the estimated cost when the query was actually settled', async () => {
    mockRequireAuth.mockResolvedValueOnce({ identity: { id: 'did:imajin:someone-else' } });
    mockCalculateCost.mockReturnValueOnce(0.05);
    stubSettlementEnv();
    vi.stubGlobal('fetch', makeSettledFetchMock());

    await POST(makeReq(), params);

    expect(mockRecordPresenceQueryUsage).toHaveBeenCalledWith(
      expect.objectContaining({ settled: true, costUsd: 0.05 }),
    );
  });

  it('never lets a ledger failure change the HTTP response already computed', async () => {
    mockRecordPresenceQueryUsage.mockRejectedValueOnce(new Error('ledger unavailable'));

    const res = await POST(makeReq(), params);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ response: 'an answer' });
  });
});
