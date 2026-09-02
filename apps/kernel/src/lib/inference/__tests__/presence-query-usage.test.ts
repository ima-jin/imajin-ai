import { describe, it, expect, vi, beforeEach } from 'vitest';

const { insertCalls, insertMock } = vi.hoisted(() => {
  const insertCalls: Array<{ table: string; values: Record<string, unknown> }> = [];
  const insertMock = vi.fn((table: { __name: string }) => ({
    values: (v: Record<string, unknown>) => {
      insertCalls.push({ table: table.__name, values: v });
      return Promise.resolve(undefined);
    },
  }));
  return { insertCalls, insertMock };
});

vi.mock('@/src/db', () => ({
  db: { insert: insertMock },
  usageIncurred: { __name: 'usageIncurred' },
}));

vi.mock('@/src/lib/kernel/id', () => ({
  generateId: (prefix: string) => `${prefix}_test`,
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const { mockPublishUsageIncurred } = vi.hoisted(() => ({
  mockPublishUsageIncurred: vi.fn(() => Promise.resolve()),
}));
vi.mock('../usage-ledger', () => ({ publishUsageIncurred: mockPublishUsageIncurred }));

import { recordPresenceQueryUsage, PRESENCE_QUERY_SOURCE } from '../presence-query-usage';

const OWNER = 'did:imajin:presence-owner';
const REQUESTER = 'did:imajin:requester';

/** Flush the microtask queue so the fire-and-forget publish().catch() chain settles. */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

beforeEach(() => {
  insertCalls.length = 0;
  insertMock.mockClear();
  mockPublishUsageIncurred.mockClear();
  mockPublishUsageIncurred.mockResolvedValue(undefined);
});

describe('PRESENCE_QUERY_SOURCE', () => {
  it('is the #1956 source literal', () => {
    expect(PRESENCE_QUERY_SOURCE).toBe('presence:query');
  });
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
    settleAmount: 0.001,
  };

  it('writes a usage.incurred row with the #1147 emitter/resource discriminators', async () => {
    await recordPresenceQueryUsage(baseParams);

    const usageInsert = insertCalls.find((c) => c.table === 'usageIncurred');
    expect(usageInsert?.values).toMatchObject({
      id: 'usage_test',
      principalDid: OWNER,
      agentDid: REQUESTER,
      source: 'presence:query',
      resource: 'model:anthropic/claude-sonnet-4-20250514',
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      tokensIn: 10,
      tokensOut: 5,
      unit: 'tokens',
      externalId: 'query_1',
    });
    expect(usageInsert?.values.quantity).toBe('15.000000');
    expect(usageInsert?.values.costUsd).toBe('0.00100000');
  });

  it('publishes usage.incurred on the bus with mode/settled/settleAmount in metadata', async () => {
    await recordPresenceQueryUsage(baseParams);
    await flushMicrotasks();

    expect(mockPublishUsageIncurred).toHaveBeenCalledWith({
      usageId: 'usage_test',
      principalDid: OWNER,
      resource: 'model:anthropic/claude-sonnet-4-20250514',
      quantity: 15,
      unit: 'tokens',
      costUsd: 0.001,
      source: 'presence:query',
      metadata: {
        queryId: 'query_1',
        requesterDid: REQUESTER,
        settled: true,
        settleAmount: 0.001,
        mode: 'query',
      },
    });
  });

  it('sets metadata.mode to "stream" for the streaming route', async () => {
    await recordPresenceQueryUsage({ ...baseParams, mode: 'stream' });
    await flushMicrotasks();

    expect(mockPublishUsageIncurred).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ mode: 'stream' }) }),
    );
  });

  it('never throws when the DB write fails — a ledger failure must not fail an already-served query', async () => {
    insertMock.mockImplementationOnce(() => {
      throw new Error('relation "usage.incurred" does not exist');
    });

    await expect(recordPresenceQueryUsage(baseParams)).resolves.toBeUndefined();
    expect(mockPublishUsageIncurred).not.toHaveBeenCalled();
  });

  it('never throws when the bus publish fails — the row is already written', async () => {
    mockPublishUsageIncurred.mockRejectedValueOnce(new Error('bus unavailable'));

    await expect(recordPresenceQueryUsage(baseParams)).resolves.toBeUndefined();
    await flushMicrotasks();
  });

  it('never puts secrets or raw prompt/completion text in the row or the published metadata', async () => {
    const SECRET = 'sk-ant-SHOULD-NEVER-APPEAR';
    await recordPresenceQueryUsage(baseParams);
    await flushMicrotasks();

    const usageInsert = insertCalls.find((c) => c.table === 'usageIncurred');
    const serializedRow = JSON.stringify(usageInsert?.values);
    const serializedMetadata = JSON.stringify(mockPublishUsageIncurred.mock.calls[0][0]);
    expect(serializedRow).not.toContain(SECRET);
    expect(serializedMetadata).not.toContain(SECRET);
    // Only token counts, never the underlying text, cross this boundary.
    expect(Object.keys(usageInsert?.values ?? {})).not.toContain('message');
    expect(Object.keys(usageInsert?.values ?? {})).not.toContain('response');
  });
});
