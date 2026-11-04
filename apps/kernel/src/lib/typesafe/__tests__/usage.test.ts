import { describe, it, expect, vi, beforeEach } from 'vitest';

const { insertMock, publishUsageIncurredMock, logError } = vi.hoisted(() => ({
  insertMock: vi.fn(),
  publishUsageIncurredMock: vi.fn(async () => undefined),
  logError: vi.fn(),
}));
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
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: logError }),
}));

import { computeTypesafeCostUsd, recordTypesafeUsage } from '../usage';

const OWNER = 'did:imajin:farmer';
beforeEach(() => {
  vi.clearAllMocks();
  publishUsageIncurredMock.mockResolvedValue(undefined);
});

describe('computeTypesafeCostUsd', () => {
  it('computes input tokens x $0.042/Mtok, output free', () => {
    expect(computeTypesafeCostUsd(1_000_000)).toBe(0.042);
    expect(computeTypesafeCostUsd(500_000)).toBe(0.021);
    expect(computeTypesafeCostUsd(1)).toBe(0.00000004);
  });
  it('distinguishes unknown usage from a genuinely free call', () => {
    expect(computeTypesafeCostUsd(undefined)).toBeUndefined();
    expect(computeTypesafeCostUsd(0)).toBe(0);
  });
});

describe('recordTypesafeUsage', () => {
  it.each([OWNER, 'did:imajin:business'])('publishes the full metering-only row for acting identity %s without any direct insert', async (ownerDid) => {
    await recordTypesafeUsage({ ownerDid, model: 'jev-1.13.0', tokensIn: 1_000_000, tokensOut: 0 });
    expect(insertMock).not.toHaveBeenCalled();
    expect(publishUsageIncurredMock).toHaveBeenCalledTimes(1);
    expect(publishUsageIncurredMock).toHaveBeenCalledWith({
      usageId: 'usage_test123',
      principalDid: ownerDid,
      source: 'typesafe-decide',
      resource: 'model:typesafe/jev-1.13.0',
      provider: 'typesafe',
      connectorId: `conn_typesafe_${ownerDid}`,
      model: 'jev-1.13.0',
      tokensIn: 1_000_000,
      tokensOut: 0,
      quantity: 1_000_000,
      costUsd: 0.042,
      metadata: { meteringOnly: true },
      sessionId: undefined,
      turnId: undefined,
      externalId: undefined,
      agentDid: undefined,
      warpRunId: undefined,
    });
  });

  it('preserves delegated agent identity separately from the acting org and all linkage', async () => {
    await recordTypesafeUsage({
      ownerDid: 'did:imajin:business', agentDid: 'did:imajin:agent', model: 'jev-latest',
      tokensIn: 10, tokensOut: 0, sessionId: 'sess-1', turnId: 'turn-1',
      warpRunId: 'run-1', externalId: 'req-1',
    });
    expect(publishUsageIncurredMock).toHaveBeenCalledWith(expect.objectContaining({
      principalDid: 'did:imajin:business', agentDid: 'did:imajin:agent',
      sessionId: 'sess-1', turnId: 'turn-1', warpRunId: 'run-1', externalId: 'req-1',
    }));
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('leaves unknown usage unknown rather than inventing zero', async () => {
    await recordTypesafeUsage({ ownerDid: OWNER, model: 'jev-latest' });
    expect(publishUsageIncurredMock).toHaveBeenCalledWith(expect.objectContaining({
      costUsd: undefined, tokensIn: undefined, tokensOut: undefined, quantity: undefined,
    }));
  });

  it('keeps quantity unknown when only one token direction is measured', async () => {
    await recordTypesafeUsage({ ownerDid: OWNER, model: 'jev-latest', tokensIn: 10 });
    expect(publishUsageIncurredMock).toHaveBeenCalledWith(expect.objectContaining({
      costUsd: 0.00000042, tokensIn: 10, tokensOut: undefined, quantity: undefined,
    }));
  });

  it('fails open on rejected publishing without a DB fallback or unhandled rejection', async () => {
    publishUsageIncurredMock.mockRejectedValueOnce(new Error('bus down'));
    await expect(recordTypesafeUsage({ ownerDid: OWNER, model: 'jev-latest' })).resolves.toBeUndefined();
    expect(logError).toHaveBeenCalledWith(expect.objectContaining({ err: 'Error: bus down' }), expect.any(String));
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('fails open on a synchronous publisher failure', async () => {
    publishUsageIncurredMock.mockImplementationOnce(() => { throw new Error('publisher unavailable'); });
    await expect(recordTypesafeUsage({ ownerDid: OWNER, model: 'jev-latest' })).resolves.toBeUndefined();
    expect(logError).toHaveBeenCalled();
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('does not wait for a slow receipt publisher', async () => {
    let complete = () => {};
    publishUsageIncurredMock.mockImplementationOnce(() => new Promise<void>((resolve) => { complete = resolve; }));
    await recordTypesafeUsage({ ownerDid: OWNER, model: 'jev-latest' });
    expect(publishUsageIncurredMock).toHaveBeenCalledTimes(1);
    complete();
  });
});
