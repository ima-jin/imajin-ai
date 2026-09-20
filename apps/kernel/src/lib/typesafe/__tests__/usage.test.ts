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

  it('#2202: writes agentDid on the row for a delegated call, mirroring recordInferenceUsage', async () => {
    const AGENT_DID = 'did:imajin:openclaw-app';
    await recordTypesafeUsage({ ownerDid: OWNER, agentDid: AGENT_DID, model: 'jev-latest', tokensIn: 10, tokensOut: 0 });

    const row = insertValuesMock.mock.calls[0][0];
    expect(row.principalDid).toBe(OWNER);
    expect(row.agentDid).toBe(AGENT_DID);
  });

  it('#2202: writes agentDid as null for a direct (non-delegated) call', async () => {
    await recordTypesafeUsage({ ownerDid: OWNER, model: 'jev-latest', tokensIn: 10, tokensOut: 0 });

    const row = insertValuesMock.mock.calls[0][0];
    expect(row.agentDid).toBeNull();
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

  it('#2204: writes externalId (x-typesafe-request-id) on the row and publishes it + sessionId/turnId/warpRunId in the bus event', async () => {
    await recordTypesafeUsage({
      ownerDid: OWNER,
      model: 'jev-latest',
      tokensIn: 10,
      tokensOut: 0,
      sessionId: 'sess-1',
      turnId: 'turn-1',
      warpRunId: 'run-1',
      externalId: 'req_abc123',
    });

    const row = insertValuesMock.mock.calls[0][0];
    expect(row.externalId).toBe('req_abc123');

    expect(publishUsageIncurredMock).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess-1',
      turnId: 'turn-1',
      warpRunId: 'run-1',
      externalId: 'req_abc123',
    }));
  });

  it('writes externalId as null when the upstream call never returned one', async () => {
    await recordTypesafeUsage({ ownerDid: OWNER, model: 'jev-latest', tokensIn: 10, tokensOut: 0 });

    const row = insertValuesMock.mock.calls[0][0];
    expect(row.externalId).toBeNull();
  });
});
