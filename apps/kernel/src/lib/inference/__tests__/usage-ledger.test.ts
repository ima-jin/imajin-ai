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
  inferenceUsage: { __name: 'inferenceUsage' },
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

import { recordInferenceUsage } from '../usage-ledger';

const OWNER = 'did:imajin:supplier';

beforeEach(() => {
  insertCalls.length = 0;
  conflictSets.length = 0;
  insertMock.mockClear();
});

describe('recordInferenceUsage', () => {
  it('writes an inference.usage row with computed cost, tokens, and a linked transaction id', async () => {
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

    const usageInsert = insertCalls.find((c) => c.table === 'inferenceUsage');
    expect(usageInsert?.values).toMatchObject({
      id: 'usage_test',
      sessionId: 'sess_1',
      turnId: 'turn_1',
      principalDid: OWNER,
      agentDid: 'did:imajin:openclaw-app',
      provider: 'xai',
      connectorId: `conn_${OWNER}_xai`,
      model: 'grok-4',
      tokensIn: 1_000_000,
      tokensOut: 1_000_000,
    });
    expect(usageInsert?.values.costUsd).toBe('18.00000000');
    expect(usageInsert?.values.transactionId).toBe('tx_test');
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

    expect(insertCalls.map((c) => c.table)).toEqual(['inferenceUsage']);
    const usageInsert = insertCalls[0];
    expect(usageInsert.values.costUsd).toBeNull();
    expect(usageInsert.values.tokensIn).toBeNull();
    expect(usageInsert.values.transactionId).toBeNull();
  });

  it('never throws when the DB write fails \u2014 a metering failure must not fail an already-served completion', async () => {
    insertMock.mockImplementationOnce(() => {
      throw new Error('relation "inference.usage" does not exist');
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
