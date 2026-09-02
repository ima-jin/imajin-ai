import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * A minimal fluent chain that supports every method `reconciliation.ts`
 * calls (`.from/.where/.groupBy`) regardless of chain order, and resolves to
 * `result` when awaited — mirrors `inference-burn-down.test.ts`'s helper.
 */
function createChain(result: unknown) {
  const chain: Record<string, unknown> = {
    from: () => chain,
    where: () => chain,
    groupBy: () => chain,
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
    principalDid: 'principal_did', provider: 'provider', model: 'model',
    costUsd: 'cost_usd', tokensIn: 'tokens_in', tokensOut: 'tokens_out', createdAt: 'created_at',
  },
  usageBilled: {
    principalDid: 'principal_did', provider: 'provider', model: 'model', granularity: 'granularity',
    billedUsd: 'billed_usd', tokensIn: 'tokens_in', tokensOut: 'tokens_out', periodStart: 'period_start',
  },
}));

vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => ({ and: args }),
  eq: (...args: unknown[]) => ({ eq: args }),
  gte: (...args: unknown[]) => ({ gte: args }),
  lt: (...args: unknown[]) => ({ lt: args }),
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ sql: strings.join('?'), values }),
}));

import { readReconciliation } from '../reconciliation';

beforeEach(() => {
  queue.length = 0;
  mockSelect.mockReset();
  mockSelect.mockImplementation(() => createChain(queue.shift() ?? []));
});

/** Enqueue results in the exact order `readReconciliation` issues its two queries. */
function enqueue(computed: unknown[], billed: unknown[]) {
  queue.push(computed);
  queue.push(billed);
}

describe('readReconciliation', () => {
  it('computes drift when both sides report the same day/provider/model', async () => {
    enqueue(
      [{ date: '2026-08-01', provider: 'anthropic', model: 'claude-opus-5', costUsd: '10.00000000', tokensIn: '1000', tokensOut: '200' }],
      [{ date: '2026-08-01', provider: 'anthropic', model: 'claude-opus-5', billedUsd: '12.50000000', tokensIn: '1050', tokensOut: '210' }],
    );

    const rows = await readReconciliation({ principalDid: 'did:imajin:owner' });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      date: '2026-08-01',
      provider: 'anthropic',
      model: 'claude-opus-5',
      computedUsd: 10,
      billedUsd: 12.5,
      driftUsd: 2.5,
      driftPct: 25,
      computedTokensIn: 1000,
      computedTokensOut: 200,
      billedTokensIn: 1050,
      billedTokensOut: 210,
    });
  });

  it('reports computed-only rows (no billed statement yet) with null billed fields and no drift', async () => {
    enqueue(
      [{ date: '2026-08-02', provider: 'openai', model: 'gpt-5.5', costUsd: '3.00000000', tokensIn: '500', tokensOut: '100' }],
      [],
    );

    const rows = await readReconciliation({ principalDid: 'did:imajin:owner' });

    expect(rows).toEqual([{
      date: '2026-08-02',
      provider: 'openai',
      model: 'gpt-5.5',
      computedUsd: 3,
      billedUsd: null,
      driftUsd: null,
      driftPct: null,
      computedTokensIn: 500,
      computedTokensOut: 100,
      billedTokensIn: null,
      billedTokensOut: null,
    }]);
  });

  it('reports billed-only rows (e.g. an org-wide OpenAI cost line with no model) with null computed fields', async () => {
    enqueue(
      [],
      [{ date: '2026-08-02', provider: 'openai', model: null, billedUsd: '7.00000000', tokensIn: null, tokensOut: null }],
    );

    const rows = await readReconciliation({ principalDid: 'did:imajin:owner' });

    expect(rows).toEqual([{
      date: '2026-08-02',
      provider: 'openai',
      model: null,
      computedUsd: null,
      billedUsd: 7,
      driftUsd: null,
      driftPct: null,
      computedTokensIn: null,
      computedTokensOut: null,
      billedTokensIn: null,
      billedTokensOut: null,
    }]);
  });

  it('leaves driftPct null when computedUsd is exactly zero (division by zero guard)', async () => {
    enqueue(
      [{ date: '2026-08-03', provider: 'anthropic', model: 'claude-haiku-4-5', costUsd: '0', tokensIn: '10', tokensOut: '2' }],
      [{ date: '2026-08-03', provider: 'anthropic', model: 'claude-haiku-4-5', billedUsd: '0.50000000', tokensIn: '10', tokensOut: '2' }],
    );

    const rows = await readReconciliation({ principalDid: 'did:imajin:owner' });

    expect(rows[0].computedUsd).toBe(0);
    expect(rows[0].driftUsd).toBe(0.5);
    expect(rows[0].driftPct).toBeNull();
  });

  it('sorts merged rows by date, then provider, then model', async () => {
    enqueue(
      [
        { date: '2026-08-02', provider: 'openai', model: 'gpt-5.5', costUsd: '1', tokensIn: null, tokensOut: null },
        { date: '2026-08-01', provider: 'anthropic', model: 'claude-opus-5', costUsd: '1', tokensIn: null, tokensOut: null },
      ],
      [],
    );

    const rows = await readReconciliation({ principalDid: 'did:imajin:owner' });

    expect(rows.map((r) => `${r.date}:${r.provider}`)).toEqual(['2026-08-01:anthropic', '2026-08-02:openai']);
  });
});
