import { describe, it, expect, vi, beforeEach } from 'vitest';

const { insertCalls, conflictSets, insertMock } = vi.hoisted(() => {
  const insertCalls: Array<{ table: string; values: Record<string, unknown> }> = [];
  const conflictSets: Record<string, unknown>[] = [];
  const insertMock = vi.fn((table: { __name: string }) => ({
    values: (v: Record<string, unknown>) => {
      insertCalls.push({ table: table.__name, values: v });
      const result = Promise.resolve(undefined) as Promise<undefined> & {
        onConflictDoUpdate: (opts: { set: Record<string, unknown> }) => Promise<undefined>;
      };
      result.onConflictDoUpdate = ({ set }) => {
        conflictSets.push(set);
        return Promise.resolve(undefined);
      };
      return result;
    },
  }));
  return { insertCalls, conflictSets, insertMock };
});

vi.mock('@/src/db', () => ({
  db: { insert: insertMock },
  usageIncurred: { __name: 'usageIncurred' },
  transactions: { __name: 'transactions' },
  balanceRollups: {
    __name: 'balanceRollups',
    did: 'did',
    date: 'date',
    service: 'service',
    earned: 'earned',
    spent: 'spent',
    txCount: 'tx_count',
  },
}));

vi.mock('drizzle-orm', () => ({
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ sql: strings.join('?'), values }),
}));

vi.mock('@/src/lib/kernel/id', () => ({
  generateId: (prefix: string) => `${prefix}_test`,
}));

vi.mock('@/src/lib/kernel/connector-registry', () => ({
  getConnector: (id: string) => (id === 'xai' ? { connectorDid: 'did:imajin:xai-connector' } : undefined),
}));

vi.mock('@/src/lib/kernel/connector-registry-store', () => ({
  connectorRegistryId: (ownerDid: string, provider: string) => `conn_${ownerDid}_${provider}`,
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const { mockPublish } = vi.hoisted(() => ({ mockPublish: vi.fn(() => Promise.resolve()) }));
vi.mock('@imajin/bus', () => ({ publish: mockPublish }));

vi.mock('@/src/lib/kernel/node-identity', () => ({
  getNodeDid: vi.fn(async () => 'did:imajin:testnode'),
}));

import { recordInferenceUsage, publishUsageIncurred } from '../usage-ledger';

const OWNER = 'did:imajin:supplier';

beforeEach(() => {
  insertCalls.length = 0;
  conflictSets.length = 0;
  insertMock.mockClear();
  mockPublish.mockClear();
  mockPublish.mockResolvedValue(undefined);
});

/** Flush the microtask queue so the fire-and-forget publish().catch() chain settles. */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('recordInferenceUsage', () => {
  it('writes a usage.incurred row with computed cost, tokens, a linked transaction id, and the #1147 emitter/resource discriminators', async () => {
    await recordInferenceUsage({
      sessionId: 'sess_1',
      turnId: 'turn_1',
      principalDid: OWNER,
      agentDid: 'did:imajin:openclaw-app',
      provider: 'xai',
      model: 'grok-4',
      tokensIn: 1_000_000,
      tokensOut: 1_000_000,
    });

    const usageInsert = insertCalls.find((c) => c.table === 'usageIncurred');
    expect(usageInsert?.values).toMatchObject({
      id: 'usage_test',
      sessionId: 'sess_1',
      turnId: 'turn_1',
      principalDid: OWNER,
      agentDid: 'did:imajin:openclaw-app',
      source: 'inference-passthrough',
      resource: 'model:xai/grok-4',
      provider: 'xai',
      connectorId: `conn_${OWNER}_xai`,
      model: 'grok-4',
      tokensIn: 1_000_000,
      tokensOut: 1_000_000,
    });
    expect(usageInsert?.values.costUsd).toBe('18.00000000');
    expect(usageInsert?.values.transactionId).toBe('tx_test');
    // #1148 emitter-agnostic quantity/unit — sum of both token directions.
    expect(usageInsert?.values.quantity).toBe('2000000.000000');
    expect(usageInsert?.values.unit).toBe('tokens');
  });

  it('publishes usage.incurred on the bus after the row is written (#1148)', async () => {
    await recordInferenceUsage({
      principalDid: OWNER,
      provider: 'xai',
      model: 'grok-4',
      tokensIn: 1_000_000,
      tokensOut: 1_000_000,
    });
    await flushMicrotasks();

    expect(mockPublish).toHaveBeenCalledWith(
      'usage.incurred',
      expect.objectContaining({
        issuer: 'did:imajin:testnode',
        subject: OWNER,
        scope: 'usage',
        payload: expect.objectContaining({
          attestationClass: 'system',
          issuerDid: 'did:imajin:testnode',
          actingFor: OWNER,
          resource: 'model:xai/grok-4',
          quantity: 2_000_000,
          unit: 'tokens',
          costEstimateUsd: 18,
          source: 'inference-passthrough',
          usageId: 'usage_test',
          context_id: 'usage_test',
          context_type: 'usage',
        }),
      }),
    );
  });

  it('never throws when the bus publish fails \u2014 the row is already written', async () => {
    mockPublish.mockRejectedValueOnce(new Error('bus unavailable'));

    await expect(
      recordInferenceUsage({ principalDid: OWNER, provider: 'xai', model: 'grok-4', tokensIn: 1, tokensOut: 1 }),
    ).resolves.toBeUndefined();
    await flushMicrotasks();
  });

  it('writes pay.transactions with service=inference and the connector DID as toDid', async () => {
    await recordInferenceUsage({
      principalDid: OWNER,
      provider: 'xai',
      model: 'grok-4',
      tokensIn: 1_000_000,
      tokensOut: 1_000_000,
    });

    const txInsert = insertCalls.find((c) => c.table === 'transactions');
    expect(txInsert?.values).toMatchObject({
      service: 'inference',
      type: 'query',
      fromDid: OWNER,
      toDid: 'did:imajin:xai-connector',
      currency: 'USD',
      status: 'completed',
    });
    // Never crams token counts into pay.transactions.metadata (issue's explicit constraint).
    expect(txInsert?.values.metadata).not.toHaveProperty('tokensIn');
    expect(txInsert?.values.metadata).not.toHaveProperty('tokensOut');
  });

  it('increments the daily pay.balance_rollups spend for service=inference', async () => {
    await recordInferenceUsage({
      principalDid: OWNER,
      provider: 'xai',
      model: 'grok-4',
      tokensIn: 1_000_000,
      tokensOut: 1_000_000,
    });

    expect(conflictSets[0]).toMatchObject({});
    const rollupInsert = insertCalls.find((c) => c.table === 'balanceRollups');
    expect(rollupInsert?.values).toMatchObject({ did: OWNER, service: 'inference', spent: '18.00000000', txCount: 1 });
  });

  it('writes only the usage row (null cost, no transaction) when tokens are unknown', async () => {
    await recordInferenceUsage({
      principalDid: OWNER,
      provider: 'xai',
      model: 'grok-4',
    });

    expect(insertCalls.map((c) => c.table)).toEqual(['usageIncurred']);
    const usageInsert = insertCalls[0];
    expect(usageInsert.values.costUsd).toBeNull();
    expect(usageInsert.values.tokensIn).toBeNull();
    expect(usageInsert.values.transactionId).toBeNull();
    expect(usageInsert.values.quantity).toBeNull();
    expect(usageInsert.values.unit).toBeNull();
  });

  it('never throws when the DB write fails \u2014 a metering failure must not fail an already-served completion', async () => {
    insertMock.mockImplementationOnce(() => {
      throw new Error('relation "usage.incurred" does not exist');
    });

    await expect(
      recordInferenceUsage({ principalDid: OWNER, provider: 'xai', model: 'grok-4', tokensIn: 1, tokensOut: 1 }),
    ).resolves.toBeUndefined();
  });

  it('falls back to a synthesized connector DID when the static registry does not know the provider', async () => {
    await recordInferenceUsage({
      principalDid: OWNER,
      provider: 'openai',
      model: 'gpt-4o',
      tokensIn: 1,
      tokensOut: 1,
    });

    const txInsert = insertCalls.find((c) => c.table === 'transactions');
    expect(txInsert?.values.toDid).toBe('did:imajin:openai-connector');
  });
});

describe('publishUsageIncurred — optional metadata passthrough (#1956)', () => {
  it('carries emitter-specific metadata in the published payload when given', async () => {
    await publishUsageIncurred({
      usageId: 'usage_1',
      principalDid: OWNER,
      resource: 'model:anthropic/claude-sonnet-4-20250514',
      quantity: 15,
      unit: 'tokens',
      costUsd: 0.05,
      source: 'presence:query',
      metadata: { queryId: 'q1', requesterDid: 'did:imajin:requester', settled: true, settleAmount: 0.05, mode: 'query' },
    });

    expect(mockPublish).toHaveBeenCalledWith(
      'usage.incurred',
      expect.objectContaining({
        payload: expect.objectContaining({
          source: 'presence:query',
          metadata: { queryId: 'q1', requesterDid: 'did:imajin:requester', settled: true, settleAmount: 0.05, mode: 'query' },
        }),
      }),
    );
  });

  it('omits metadata entirely from the payload when not given — existing emitters unaffected', async () => {
    await publishUsageIncurred({
      usageId: 'usage_2',
      principalDid: OWNER,
      resource: 'model:xai/grok-4',
      quantity: 10,
      costUsd: 1,
      source: 'inference-passthrough',
    });

    const call = mockPublish.mock.calls.find(([, event]) => (event as { payload: { usageId: string } }).payload.usageId === 'usage_2');
    expect(call?.[1].payload).not.toHaveProperty('metadata');
  });
});
