import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * A minimal fluent chain that supports every method
 * `inference-burn-down.ts` calls (`.from/.where/.groupBy/.orderBy/.limit`)
 * regardless of how many are chained, and resolves to `result` when awaited.
 */
function createChain(result: unknown) {
  const chain: Record<string, unknown> = {
    from: () => chain,
    where: () => chain,
    groupBy: () => chain,
    orderBy: () => chain,
    limit: () => chain,
    then: (resolve: (value: unknown) => void) => resolve(result),
  };
  return chain;
}

const { mockSelect, queue } = vi.hoisted(() => {
  const queue: unknown[] = [];
  const mockSelect = vi.fn();
  return { mockSelect, queue };
});

vi.mock('@/src/db', () => ({
  db: { select: mockSelect },
  usageIncurred: {
    connectorId: 'connector_id',
    sessionId: 'session_id',
    turnId: 'turn_id',
    agentDid: 'agent_did',
    costUsd: 'cost_usd',
    tokensIn: 'tokens_in',
    tokensOut: 'tokens_out',
    createdAt: 'created_at',
  },
}));

vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => ({ and: args }),
  eq: (...args: unknown[]) => ({ eq: args }),
  gte: (...args: unknown[]) => ({ gte: args }),
  desc: (arg: unknown) => ({ desc: arg }),
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ sql: strings.join('?'), values }),
}));

import { readInferenceBurnDown } from '../inference-burn-down';

beforeEach(() => {
  queue.length = 0;
  mockSelect.mockReset();
  mockSelect.mockImplementation(() => createChain(queue.shift() ?? []));
});

/** Enqueue results in the exact order `readInferenceBurnDown` issues its queries. */
function enqueueLifetimeQueries(opts: {
  totals?: { totalCostUsd: string; totalCallCount: string };
  bySession?: unknown[];
  byTurn?: unknown[];
  byAgent?: unknown[];
  cappedSpend?: { total: string };
}) {
  queue.push([opts.totals ?? { totalCostUsd: '0', totalCallCount: '0' }]);
  queue.push(opts.bySession ?? []);
  queue.push(opts.byTurn ?? []);
  queue.push(opts.byAgent ?? []);
  if (opts.cappedSpend) queue.push([opts.cappedSpend]);
}

describe('readInferenceBurnDown', () => {
  it('reports zero totals and no cap for a connector with no registration and no usage', async () => {
    enqueueLifetimeQueries({});

    const result = await readInferenceBurnDown('conn_x', 'xai', 'did:imajin:owner', undefined);

    expect(result).toMatchObject({
      connectorId: 'conn_x',
      provider: 'xai',
      ownerDid: 'did:imajin:owner',
      spendCap: null,
      spentUsd: 0,
      totalCostUsd: 0,
      totalCallCount: 0,
      bySession: [],
      byTurn: [],
      byAgent: [],
    });
  });

  it('uses the lifetime total as spentUsd when the connector has no cap', async () => {
    enqueueLifetimeQueries({ totals: { totalCostUsd: '42.5', totalCallCount: '10' } });

    const result = await readInferenceBurnDown('conn_x', 'xai', 'did:imajin:owner', undefined);

    expect(result.spentUsd).toBe(42.5);
    expect(result.totalCostUsd).toBe(42.5);
    expect(result.totalCallCount).toBe(10);
  });

  it('reads a scoped capped-window spend when the connector has a declared cap', async () => {
    enqueueLifetimeQueries({
      totals: { totalCostUsd: '42.5', totalCallCount: '10' },
      cappedSpend: { total: '5' },
    });

    const registration = { spendCap: { amountUsd: 20, period: 'daily' } } as never;
    const result = await readInferenceBurnDown('conn_x', 'xai', 'did:imajin:owner', registration);

    expect(result.spendCap).toEqual({ amountUsd: 20, period: 'daily' });
    // spentUsd is the DAILY window figure (5), not the lifetime total (42.5).
    expect(result.spentUsd).toBe(5);
    expect(result.totalCostUsd).toBe(42.5);
  });

  it('treats a malformed spend_cap as no cap', async () => {
    enqueueLifetimeQueries({ totals: { totalCostUsd: '1', totalCallCount: '1' } });

    const registration = { spendCap: { amountUsd: -1, period: 'daily' } } as never;
    const result = await readInferenceBurnDown('conn_x', 'xai', 'did:imajin:owner', registration);

    expect(result.spendCap).toBeNull();
    expect(result.spentUsd).toBe(1);
  });

  it('maps grouped rows to numeric fields for the session/turn/agent breakdowns', async () => {
    enqueueLifetimeQueries({
      bySession: [{ key: 'sess_1', costUsd: '3.5', tokensIn: '100', tokensOut: '50', callCount: '2' }],
      byTurn: [{ key: 'turn_1', costUsd: '3.5', tokensIn: '100', tokensOut: '50', callCount: '2' }],
      byAgent: [{ key: null, costUsd: '3.5', tokensIn: '100', tokensOut: '50', callCount: '2' }],
    });

    const result = await readInferenceBurnDown('conn_x', 'xai', 'did:imajin:owner', undefined);

    expect(result.bySession).toEqual([{ key: 'sess_1', costUsd: 3.5, tokensIn: 100, tokensOut: 50, callCount: 2 }]);
    expect(result.byTurn).toEqual([{ key: 'turn_1', costUsd: 3.5, tokensIn: 100, tokensOut: 50, callCount: 2 }]);
    expect(result.byAgent).toEqual([{ key: null, costUsd: 3.5, tokensIn: 100, tokensOut: 50, callCount: 2 }]);
  });
});
