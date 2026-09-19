/**
 * TypeSafe.ai usage-ledger tests (#2197).
 *
 * Pins the cost formula (input tokens x $0.042/Mtok, output free), that a
 * row is written straight to `usage.incurred` with no `pay.transactions` /
 * `pay.balance_rollups` side effect (no spend-cap or brain coupling, per the
 * issue), and that the write fails open.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { insertValuesMock, insertMock, publishUsageIncurredMock } = vi.hoisted(() => ({
  insertValuesMock: vi.fn(async () => undefined),
  insertMock: vi.fn(() => ({ values: vi.fn() })),
  publishUsageIncurredMock: vi.fn(async () => undefined),
}));

// `insertMock` returns an object referencing `insertValuesMock` so the
// per-call `.values(...)` mock is the same instance tests assert against.
insertMock.mockImplementation(() => ({ values: insertValuesMock }));

vi.mock('@/src/db', () => ({
  db: { insert: insertMock },
  usageIncurred: { __table: 'usage.incurred' },
}));
vi.mock('@/src/lib/kernel/id', () => ({
  generateId: (prefix: string) => `${prefix}_test123`,
}));
vi.mock('@/src/lib/kernel/connector-registry-store', () => ({
  connectorRegistryId: (ownerDid: string, provider: string) => `conn_${provider}_${ownerDid}`,
}));
vi.mock('@/src/lib/inference/usage-ledger', () => ({
  publishUsageIncurred: publishUsageIncurredMock,
}));
vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { computeTypesafeCostUsd, recordTypesafeUsage } from '../usage';

const OWNER = 'did:imajin:farmer';

beforeEach(() => {
  insertValuesMock.mockClear();
  insertMock.mockClear();
  publishUsageIncurredMock.mockClear();
});

describe('computeTypesafeCostUsd', () => {
  it('computes input tokens x $0.042/Mtok, ignoring output tokens (free)', () => {
    expect(computeTypesafeCostUsd(1_000_000)).toBe(0.042);
    expect(computeTypesafeCostUsd(500_000)).toBe(0.021);
  });

  it('returns undefined (never 0) when the input token count is unknown', () => {
    expect(computeTypesafeCostUsd(undefined)).toBeUndefined();
  });

  it('returns exactly 0 for a genuinely zero-token call, distinct from unknown', () => {
    expect(computeTypesafeCostUsd(0)).toBe(0);
  });
});

describe('recordTypesafeUsage', () => {
  it('writes one usage.incurred row with provider typesafe and the resolved model', async () => {
    await recordTypesafeUsage({ ownerDid: OWNER, model: 'jev-1.13.0', tokensIn: 1_000_000, tokensOut: 0 });

    expect(insertMock).toHaveBeenCalledTimes(1);
    const row = insertValuesMock.mock.calls[0][0];
    expect(row).toMatchObject({
      principalDid: OWNER,
      source: 'typesafe-decide',
      resource: 'model:typesafe/jev-1.13.0',
      provider: 'typesafe',
      model: 'jev-1.13.0',
      tokensIn: 1_000_000,
      tokensOut: 0,
      costUsd: '0.04200000',
      transactionId: null,
    });
  });

  it('never writes a pay.transactions row or spend-cap side effect (no brain coupling)', async () => {
    await recordTypesafeUsage({ ownerDid: OWNER, model: 'jev-latest', tokensIn: 100, tokensOut: 0 });

    // The only DB call this module makes is the usage.incurred insert.
    expect(insertMock).toHaveBeenCalledTimes(1);
    const row = insertValuesMock.mock.calls[0][0];
    expect(row.transactionId).toBeNull();
  });

  it('publishes the shared usage.incurred bus event', async () => {
    await recordTypesafeUsage({ ownerDid: OWNER, model: 'jev-latest', tokensIn: 200, tokensOut: 0 });

    expect(publishUsageIncurredMock).toHaveBeenCalledWith(expect.objectContaining({
      principalDid: OWNER,
      resource: 'model:typesafe/jev-latest',
      source: 'typesafe-decide',
    }));
  });

  it('degrades to a null-cost row rather than throwing when tokens are unknown', async () => {
    await recordTypesafeUsage({ ownerDid: OWNER, model: 'jev-latest' });

    const row = insertValuesMock.mock.calls[0][0];
    expect(row.costUsd).toBeNull();
    expect(row.tokensIn).toBeNull();
    expect(row.quantity).toBeNull();
  });

  it('fails open: a DB write failure never throws back to the caller', async () => {
    insertValuesMock.mockRejectedValueOnce(new Error('db down'));

    await expect(recordTypesafeUsage({ ownerDid: OWNER, model: 'jev-latest', tokensIn: 10, tokensOut: 0 })).resolves.toBeUndefined();
  });
});
