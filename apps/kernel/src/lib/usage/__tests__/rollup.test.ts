import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * A minimal fluent chain that supports every method `rollup.ts` calls
 * (`.from/.where/.groupBy/.limit`) regardless of how many are chained, and
 * resolves to `result` when awaited.
 */
function createChain(result: unknown) {
  const chain: Record<string, unknown> = {
    from: () => chain,
    where: () => chain,
    groupBy: () => chain,
    limit: () => chain,
    then: (resolve: (value: unknown) => void) => resolve(result),
  };
  return chain;
}

const { mockSelect, queue, mockPublish } = vi.hoisted(() => {
  const queue: unknown[] = [];
  const mockSelect = vi.fn();
  const mockPublish = vi.fn(() => Promise.resolve());
  return { mockSelect, queue, mockPublish };
});

vi.mock('@/src/db', () => ({
  db: { select: mockSelect },
  usageIncurred: {
    principalDid: 'principal_did',
    resource: 'resource',
    source: 'source',
    quantity: 'quantity',
    unit: 'unit',
    costUsd: 'cost_usd',
    createdAt: 'created_at',
  },
  attestations: {
    id: 'id',
    type: 'type',
    contextId: 'context_id',
  },
}));

vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => ({ and: args }),
  eq: (...args: unknown[]) => ({ eq: args }),
  gte: (...args: unknown[]) => ({ gte: args }),
  lt: (...args: unknown[]) => ({ lt: args }),
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ sql: strings.join('?'), values }),
}));

vi.mock('@imajin/bus', () => ({ publish: mockPublish }));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('@/src/lib/kernel/node-identity', () => ({
  getNodeDid: vi.fn(async () => 'did:imajin:testnode'),
}));

import { runUsageRollup, contextIdFor } from '../rollup';

const WINDOW_START = new Date('2026-09-01T00:00:00.000Z');
const WINDOW_END = new Date('2026-09-02T00:00:00.000Z');

beforeEach(() => {
  queue.length = 0;
  mockSelect.mockReset();
  mockPublish.mockClear();
  mockPublish.mockResolvedValue(undefined);
  mockSelect.mockImplementation(() => createChain(queue.shift() ?? []));
});

describe('contextIdFor', () => {
  it('formats as usage-rollup:{principalDid}:{UTC date}', () => {
    expect(contextIdFor('did:imajin:alice', WINDOW_START)).toBe('usage-rollup:did:imajin:alice:2026-09-01');
  });
});

describe('runUsageRollup', () => {
  it('returns empty and never publishes when there is no usage in the window', async () => {
    queue.push([]); // grouped usage query

    const results = await runUsageRollup(WINDOW_START, WINDOW_END);

    expect(results).toEqual([]);
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('groups rows by (principal, resource, source) and publishes one usage.rollup event per principal, resource-blind', async () => {
    queue.push([
      {
        principalDid: 'did:imajin:alice',
        resource: 'model:xai/grok-4',
        source: 'inference-passthrough',
        quantity: '100',
        unit: 'tokens',
        costUsd: '1.5',
      },
      {
        principalDid: 'did:imajin:alice',
        resource: 'model:openai/gpt-4o',
        source: 'inference-passthrough',
        quantity: '50',
        unit: 'tokens',
        costUsd: '0.5',
      },
      {
        principalDid: 'did:imajin:bob',
        resource: 'model:xai/grok-4',
        source: 'inference-passthrough',
        quantity: '10',
        unit: 'tokens',
        costUsd: '0.1',
      },
    ]);
    queue.push([]); // alice: no existing attestation
    queue.push([]); // bob: no existing attestation

    const results = await runUsageRollup(WINDOW_START, WINDOW_END);

    expect(results).toHaveLength(2);
    const alice = results.find((r) => r.principalDid === 'did:imajin:alice')!;
    expect(alice.skipped).toBe(false);
    expect(alice.contextId).toBe(contextIdFor('did:imajin:alice', WINDOW_START));
    expect(alice.totalCostEstimateUsd).toBeCloseTo(2);
    expect(alice.breakdown).toEqual([
      { resource: 'model:xai/grok-4', source: 'inference-passthrough', quantity: 100, unit: 'tokens', costEstimateUsd: 1.5 },
      { resource: 'model:openai/gpt-4o', source: 'inference-passthrough', quantity: 50, unit: 'tokens', costEstimateUsd: 0.5 },
    ]);

    expect(mockPublish).toHaveBeenCalledTimes(2);
    expect(mockPublish).toHaveBeenCalledWith(
      'usage.rollup',
      expect.objectContaining({
        issuer: 'did:imajin:testnode',
        subject: 'did:imajin:alice',
        scope: 'usage',
        payload: expect.objectContaining({
          attestationClass: 'system',
          issuerDid: 'did:imajin:testnode',
          actingFor: 'did:imajin:alice',
          windowStart: WINDOW_START.toISOString(),
          windowEnd: WINDOW_END.toISOString(),
          totalCostEstimateUsd: 2,
          source: 'usage-rollup-cron',
          context_type: 'usage.rollup',
        }),
      }),
    );
  });

  it('skips (does not re-publish) a principal that already has a usage.rollup attestation for the window', async () => {
    queue.push([
      {
        principalDid: 'did:imajin:alice',
        resource: 'model:xai/grok-4',
        source: 'inference-passthrough',
        quantity: '100',
        unit: 'tokens',
        costUsd: '1.5',
      },
    ]);
    queue.push([{ id: 'att_existing' }]); // existing attestation found

    const results = await runUsageRollup(WINDOW_START, WINDOW_END);

    expect(results).toHaveLength(1);
    expect(results[0].skipped).toBe(true);
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('never throws when the bus publish fails for one principal', async () => {
    queue.push([
      {
        principalDid: 'did:imajin:alice',
        resource: 'model:xai/grok-4',
        source: 'inference-passthrough',
        quantity: '100',
        unit: 'tokens',
        costUsd: '1.5',
      },
    ]);
    queue.push([]);
    mockPublish.mockRejectedValueOnce(new Error('bus down'));

    await expect(runUsageRollup(WINDOW_START, WINDOW_END)).resolves.toHaveLength(1);
  });

  it('treats a row with unknown quantity/cost as null/zero rather than fabricating a number', async () => {
    queue.push([
      {
        principalDid: 'did:imajin:alice',
        resource: 'model:xai/grok-4',
        source: 'inference-passthrough',
        quantity: null,
        unit: null,
        costUsd: null,
      },
    ]);
    queue.push([]);

    const results = await runUsageRollup(WINDOW_START, WINDOW_END);

    expect(results[0].breakdown).toEqual([
      { resource: 'model:xai/grok-4', source: 'inference-passthrough', quantity: null, unit: null, costEstimateUsd: 0 },
    ]);
    expect(results[0].totalCostEstimateUsd).toBe(0);
  });
});
