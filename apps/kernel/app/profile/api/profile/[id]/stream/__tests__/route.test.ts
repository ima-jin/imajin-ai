/**
 * Tests for POST /profile/api/profile/:id/stream (#1956).
 *
 * The route's auth/trust/brain-resolution gates mirror the sibling `/query`
 * route exactly (see its own test suite, `../../query/__tests__/route.test.ts`,
 * for that coverage — #1621). This suite focuses on what is unique to the
 * streaming path: the `onFinish` usage.incurred emission, fired once per
 * served query with the final token counts, fail-open so a ledger hiccup can
 * never block or alter the SSE stream already served to the caller. Shared
 * vi.mock boilerplate/fixtures live in `../../__tests__/route-test-support`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  mockRequireAuth,
  mockCreatePresenceTools,
  mockRegistryUrl,
  mockResolveBrain,
  mockStreamText,
  mockCalculateCost,
  mockRecordPresenceQueryUsage,
  OWNER_DID,
  REQUESTER_DID,
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

/** Minimal shape the route's `for await (const part of result.fullStream)` loop needs. */
async function* fakeFullStream(): AsyncGenerator<{ type: string; text?: string }> {
  yield { type: 'text-delta', text: 'hi' };
}

type OnFinishArg = { totalUsage: { inputTokens: number; outputTokens: number }; steps: unknown[] };

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
  resetPresenceRouteMocks();
  mockStreamText.mockReturnValue({ fullStream: fakeFullStream() });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ─── usage.incurred emission (#1956) ──────────────────────────────────────────

describe('presence stream — usage.incurred emission (#1956)', () => {
  it('keeps the public text/tool-call/tool-result protocol with SDK 5 parts', async () => {
    async function* toolStream() {
      yield { type: 'text-delta', text: 'hello' };
      yield { type: 'tool-call', toolName: 'lookup', input: { query: 'hello' } };
      yield { type: 'tool-result', toolName: 'lookup', output: { found: true } };
    }
    mockStreamText.mockReturnValueOnce({ fullStream: toolStream() });
    const response = await POST(makeReq(), params);
    const events = (await response.text()).trim().split('\n').map(line => JSON.parse(line));
    expect(events).toEqual([
      { type: 'text', text: 'hello' },
      { type: 'tool_call', name: 'lookup', args: { query: 'hello' } },
      { type: 'tool_result', name: 'lookup', result: { found: true } },
      { type: 'done' },
    ]);
    const options = mockStreamText.mock.calls[0][0];
    expect(options.stopWhen({ steps: Array.from({ length: 5 }, () => ({})) })).toBe(true);
    options.onStepFinish({ finishReason: 'tool-calls', toolCalls: [{}], toolResults: [{}], text: '' });
  });
  it('omits unregistered app tool endpoints rather than inventing env destinations', async () => {
    mockRegistryUrl.mockResolvedValue(null);
    await POST(makeReq(), params);
    expect(mockCreatePresenceTools).toHaveBeenCalledWith(expect.objectContaining({
      eventsUrl: '', learnUrl: '',
    }));
  });
  it('emits exactly one usage.incurred row on completion, with the final token counts', async () => {
    const res = await POST(makeReq(), params);
    expect(res.status).toBe(200);

    const onFinish = captureOnFinish();
    await onFinish({ totalUsage: { inputTokens: 20, outputTokens: 8 }, steps: [] });

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
    await onFinish({ totalUsage: { inputTokens: 1, outputTokens: 1 }, steps: [] });

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
    const onFinish = captureOnFinish();
    await onFinish({ totalUsage: { inputTokens: 4, outputTokens: 2 }, steps: [] });

    expect(mockRecordPresenceQueryUsage).toHaveBeenCalledWith(
      expect.objectContaining({ settled: true, costUsd: 0.05, requesterDid: 'did:imajin:someone-else' }),
    );
  });

  it('emits only once per query even when onFinish reports multiple steps', async () => {
    await POST(makeReq(), params);
    const onFinish = captureOnFinish();

    await onFinish({ totalUsage: { inputTokens: 5, outputTokens: 3 }, steps: [{}, {}, {}] });

    expect(mockRecordPresenceQueryUsage).toHaveBeenCalledTimes(1);
  });

  it('never lets a ledger failure block or alter the SSE stream already served', async () => {
    mockRecordPresenceQueryUsage.mockRejectedValueOnce(new Error('ledger unavailable'));

    const res = await POST(makeReq(), params);
    expect(res.status).toBe(200);

    const onFinish = captureOnFinish();
    await expect(
      onFinish({ totalUsage: { inputTokens: 1, outputTokens: 1 }, steps: [] }),
    ).resolves.toBeUndefined();

    const text = await res.text();
    expect(text).toContain('"type":"text"');
    expect(text).toContain('"type":"done"');
  });
});
