import { describe, it, expect, vi, beforeEach } from 'vitest';

const { insertMock, mockPublishUsageIncurred, logError, generateIdMock } = vi.hoisted(() => ({
  insertMock: vi.fn(),
  mockPublishUsageIncurred: vi.fn(async () => undefined),
  logError: vi.fn(),
  generateIdMock: vi.fn((prefix: string) => `${prefix}_test`),
}));

vi.mock('@/src/db', () => ({
  db: { insert: insertMock },
  usageIncurred: { __name: 'usageIncurred' },
}));
vi.mock('@/src/lib/kernel/id', () => ({ generateId: generateIdMock }));
vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: logError }),
}));
vi.mock('../usage-ledger', () => ({ publishUsageIncurred: mockPublishUsageIncurred }));

import { recordPresenceQueryUsage, PRESENCE_QUERY_SOURCE } from '../presence-query-usage';

const OWNER = 'did:imajin:presence-owner';
const REQUESTER = 'did:imajin:requester';

beforeEach(() => {
  vi.clearAllMocks();
  mockPublishUsageIncurred.mockResolvedValue(undefined);
});

describe('recordPresenceQueryUsage', () => {
  const baseParams = {
    queryId: 'query_1',
    mode: 'query' as const,
    actingForDid: OWNER,
    requesterDid: REQUESTER,
    provider: 'anthropic',
    modelId: 'claude-sonnet-4-20250514',
    promptTokens: 10,
    completionTokens: 5,
    costUsd: 0.001,
    settled: true,
  };

  it('keeps the reporting source literal', () => {
    expect(PRESENCE_QUERY_SOURCE).toBe('presence:query');
  });

  it.each([OWNER, 'did:imajin:business'])('publishes all projection fields for acting identity %s with no direct insert', async (actingForDid) => {
    await recordPresenceQueryUsage({ ...baseParams, actingForDid });

    expect(insertMock).not.toHaveBeenCalled();
    expect(mockPublishUsageIncurred).toHaveBeenCalledTimes(1);
    expect(mockPublishUsageIncurred).toHaveBeenCalledWith({
      usageId: 'usage_test',
      principalDid: actingForDid,
      resource: 'model:anthropic/claude-sonnet-4-20250514',
      quantity: 15,
      unit: 'tokens',
      costUsd: 0.001,
      source: 'presence:query',
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      tokensIn: 10,
      tokensOut: 5,
      agentDid: REQUESTER,
      externalId: 'query_1',
      metadata: {
        queryId: 'query_1',
        requesterDid: REQUESTER,
        settled: true,
        settleAmount: 0.001,
        mode: 'query',
      },
    });
    expect(logError).not.toHaveBeenCalled();
  });

  it('keeps estimated cost but sets settleAmount to zero for an unsettled query', async () => {
    await recordPresenceQueryUsage({ ...baseParams, settled: false });
    expect(mockPublishUsageIncurred).toHaveBeenCalledWith(expect.objectContaining({
      costUsd: 0.001,
      metadata: expect.objectContaining({ settled: false, settleAmount: 0 }),
    }));
  });

  it('preserves known zero cost and token counts', async () => {
    await recordPresenceQueryUsage({ ...baseParams, costUsd: 0, promptTokens: 0, completionTokens: 0 });
    expect(mockPublishUsageIncurred).toHaveBeenCalledWith(expect.objectContaining({
      costUsd: 0, tokensIn: 0, tokensOut: 0, quantity: 0,
    }));
  });

  it('marks streaming queries in the receipt metadata', async () => {
    await recordPresenceQueryUsage({ ...baseParams, mode: 'stream' });
    expect(mockPublishUsageIncurred).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ mode: 'stream' }) }),
    );
  });

  it.each(['rejection', 'synchronous throw'])('fails open on publisher %s with one countable error and no fallback insert', async (failure) => {
    const error = new Error('bus unavailable');
    if (failure === 'rejection') {
      mockPublishUsageIncurred.mockRejectedValueOnce(error);
    } else {
      mockPublishUsageIncurred.mockImplementationOnce(() => { throw error; });
    }

    await expect(recordPresenceQueryUsage(baseParams)).resolves.toBeUndefined();
    expect(logError).toHaveBeenCalledTimes(1);
    expect(logError).toHaveBeenCalledWith({
      event: 'usage_publish_failed',
      source: 'presence:query',
      err: 'Error: bus unavailable',
      queryId: 'query_1',
      actingForDid: OWNER,
      provider: 'anthropic',
      modelId: 'claude-sonnet-4-20250514',
      mode: 'query',
    }, expect.any(String));
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('logs receipt preparation failures and still serves the query without a DB fallback', async () => {
    generateIdMock.mockImplementationOnce(() => { throw new Error('ID unavailable'); });
    await expect(recordPresenceQueryUsage(baseParams)).resolves.toBeUndefined();
    expect(logError).toHaveBeenCalledTimes(1);
    expect(logError).toHaveBeenCalledWith(expect.objectContaining({
      event: 'usage_publish_failed', source: 'presence:query', err: 'Error: ID unavailable',
    }), expect.any(String));
    expect(mockPublishUsageIncurred).not.toHaveBeenCalled();
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('does not wait for a slow publisher', async () => {
    let complete = () => {};
    mockPublishUsageIncurred.mockImplementationOnce(() => new Promise<void>((resolve) => { complete = resolve; }));
    await recordPresenceQueryUsage(baseParams);
    expect(mockPublishUsageIncurred).toHaveBeenCalledTimes(1);
    expect(insertMock).not.toHaveBeenCalled();
    complete();
  });

  it('does not forward raw prompt, completion, or credential fields from the caller', async () => {
    const params = { ...baseParams, prompt: 'private input', response: 'private output', credential: 'private credential' };
    await recordPresenceQueryUsage(params);
    const serialized = JSON.stringify(mockPublishUsageIncurred.mock.calls[0]);
    for (const value of [params.prompt, params.response, params.credential]) {
      expect(serialized).not.toContain(value);
    }
  });
});
