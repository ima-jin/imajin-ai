import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * A minimal fluent chain supporting every method `summary.ts` calls
 * (`.from/.where/.groupBy/.orderBy/.limit`) regardless of order, resolving
 * to `result` when awaited — same helper shape as `reconciliation.test.ts`.
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

const { mockSelect, queue, mockReadReconciliation } = vi.hoisted(() => ({
  mockSelect: vi.fn(),
  queue: [] as unknown[],
  mockReadReconciliation: vi.fn(),
}));

vi.mock('@/src/db', () => ({
  db: { select: mockSelect },
  usageIncurred: { principalDid: 'principal_did', provider: 'provider', costUsd: 'cost_usd', createdAt: 'created_at' },
  usageBilled: {
    principalDid: 'principal_did', provider: 'provider', source: 'source', granularity: 'granularity',
    billedUsd: 'billed_usd', periodStart: 'period_start',
  },
  attestations: { type: 'type', subjectDid: 'subject_did', revokedAt: 'revoked_at', issuedAt: 'issued_at', id: 'id' },
}));

vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => ({ and: args }),
  eq: (...args: unknown[]) => ({ eq: args }),
  gte: (...args: unknown[]) => ({ gte: args }),
  lt: (...args: unknown[]) => ({ lt: args }),
  isNull: (...args: unknown[]) => ({ isNull: args }),
  desc: (...args: unknown[]) => ({ desc: args }),
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ sql: strings.join('?'), values }),
}));

vi.mock('../reconciliation', () => ({ readReconciliation: mockReadReconciliation }));

import { readUsageSummary } from '../summary';

const PRINCIPAL_DID = 'did:imajin:owner';
const FROM = new Date('2026-08-01T00:00:00.000Z');
const TO = new Date('2026-09-01T00:00:00.000Z');

beforeEach(() => {
  queue.length = 0;
  mockSelect.mockReset();
  mockSelect.mockImplementation(() => createChain(queue.shift() ?? []));
  mockReadReconciliation.mockReset();
  mockReadReconciliation.mockResolvedValue([]);
});

/** Enqueue results in the exact order readUsageSummary's three db.select calls issue them. */
function enqueue(incurred: unknown[], billed: unknown[], rollup: unknown[]) {
  queue.push(incurred, billed, rollup);
}

describe('readUsageSummary', () => {
  it('sums incurred by provider and reports the grand total', async () => {
    enqueue(
      [
        { provider: 'anthropic', costUsd: '10.00000000' },
        { provider: 'openai', costUsd: '5.50000000' },
      ],
      [],
      [],
    );

    const result = await readUsageSummary({ principalDid: PRINCIPAL_DID, from: FROM, to: TO, windowLabel: '2026-08' });

    expect(result.incurred).toEqual({ total: 15.5, byProvider: { anthropic: 10, openai: 5.5 } });
  });

  it('counts an api-sourced day-granularity billed row but excludes its overlapping month bucket', async () => {
    enqueue(
      [],
      [
        { provider: 'anthropic', source: 'api', granularity: 'day', billedUsd: '12.00000000' },
        { provider: 'anthropic', source: 'api', granularity: 'month', billedUsd: '12.00000000' },
      ],
      [],
    );

    const result = await readUsageSummary({ principalDid: PRINCIPAL_DID, from: FROM, to: TO, windowLabel: '2026-08' });

    expect(result.billed).toEqual({ total: 12, byVendor: { anthropic: 12 }, bySource: { api: 12 } });
  });

  it('always counts manual/document rows, grouped by vendor and by source', async () => {
    enqueue(
      [],
      [
        { provider: 'aws', source: 'manual', granularity: 'manual', billedUsd: '40.00000000' },
        { provider: 'aws', source: 'document', granularity: 'manual', billedUsd: '9.99000000' },
      ],
      [],
    );

    const result = await readUsageSummary({ principalDid: PRINCIPAL_DID, from: FROM, to: TO, windowLabel: '2026-08' });

    expect(result.billed.total).toBeCloseTo(49.99);
    expect(result.billed.byVendor.aws).toBeCloseTo(49.99);
    expect(result.billed.bySource).toEqual({ manual: 40, document: 9.99 });
  });

  it('sums driftUsd across whatever reconciliation returns for the same window', async () => {
    enqueue([], [], []);
    mockReadReconciliation.mockResolvedValueOnce([
      { driftUsd: 2.5 },
      { driftUsd: null },
      { driftUsd: -1 },
    ]);

    const result = await readUsageSummary({ principalDid: PRINCIPAL_DID, from: FROM, to: TO, windowLabel: '2026-08' });

    expect(result.drift).toBe(1.5);
    expect(mockReadReconciliation).toHaveBeenCalledWith({ principalDid: PRINCIPAL_DID, from: FROM, to: TO });
  });

  it('returns the latest usage.rollup attestation pointer within the window', async () => {
    enqueue([], [], [{ id: 'att_123', issuedAt: new Date('2026-08-20T00:00:00.000Z') }]);

    const result = await readUsageSummary({ principalDid: PRINCIPAL_DID, from: FROM, to: TO, windowLabel: '2026-08' });

    expect(result.rollup).toEqual({ attestationId: 'att_123', signedAt: '2026-08-20T00:00:00.000Z' });
  });

  it('returns a null rollup pointer when no attestation falls inside the window', async () => {
    enqueue([], [], []);

    const result = await readUsageSummary({ principalDid: PRINCIPAL_DID, from: FROM, to: TO, windowLabel: '2026-08' });

    expect(result.rollup).toBeNull();
  });

  it('echoes back the requested did, window label, and USD currency', async () => {
    enqueue([], [], []);

    const result = await readUsageSummary({ principalDid: PRINCIPAL_DID, from: FROM, to: TO, windowLabel: '2026-08' });

    expect(result.did).toBe(PRINCIPAL_DID);
    expect(result.window).toBe('2026-08');
    expect(result.currency).toBe('USD');
  });
});
