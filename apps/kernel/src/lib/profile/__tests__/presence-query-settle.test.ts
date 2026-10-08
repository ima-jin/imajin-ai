/**
 * `settleQueryCost` (#2642): the presence-query cost split settles IN-PROCESS
 * through `settlePayment()` — no HTTP hop to `/pay/api/settle`, no shared key.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { settlePaymentMock } = vi.hoisted(() => ({ settlePaymentMock: vi.fn() }));
vi.mock('@/src/lib/pay/settle-core', () => ({ settlePayment: settlePaymentMock }));
vi.mock('@/src/db', () => ({ db: {} }));

import { settleQueryCost } from '../presence-query';

const base = {
  cost: 0.5,
  isSelf: false,
  requesterDid: 'did:imajin:requester',
  resolvedTargetDid: 'did:imajin:owner',
  queryId: 'query_1',
  modelId: 'model-x',
  promptTokens: 10,
  completionTokens: 20,
};

const log = { error: vi.fn() };
let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('PLATFORM_DID', 'did:imajin:platform');
  vi.stubEnv('PLATFORM_FEE_PERCENT', '0.2');
  fetchSpy = vi.fn();
  vi.stubGlobal('fetch', fetchSpy);
  settlePaymentMock.mockResolvedValue({ settled: true, batchId: 'batch_1', transactions: [], total_amount: 0.5, recipients: 2, source: 'fiat' });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('settleQueryCost — in-process settlement (#2642)', () => {
  it('settles the cost split through settlePayment() with no PAY_SERVICE_* env and no HTTP', async () => {
    delete process.env.PAY_SERVICE_URL;
    delete process.env.PAY_SERVICE_API_KEY;

    await expect(settleQueryCost(base)).resolves.toBe(true);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(settlePaymentMock).toHaveBeenCalledWith({
      from_did: 'did:imajin:requester',
      total_amount: 0.5,
      service: 'inference',
      type: 'query',
      fair_manifest: {
        chain: [
          { did: 'did:imajin:owner', amount: 0.4, role: 'presence-owner' },
          { did: 'did:imajin:platform', amount: 0.1, role: 'infrastructure' },
        ],
      },
      metadata: { queryId: 'query_1', model: 'model-x', promptTokens: 10, completionTokens: 20 },
    });
  });

  it.each([
    ['a zero cost', { cost: 0 }],
    ['a self query', { isSelf: true }],
  ])('does not settle %s', async (_label, patch) => {
    await expect(settleQueryCost({ ...base, ...patch })).resolves.toBe(false);
    expect(settlePaymentMock).not.toHaveBeenCalled();
  });

  it('does not settle when PLATFORM_DID is not configured', async () => {
    delete process.env.PLATFORM_DID;
    await expect(settleQueryCost(base)).resolves.toBe(false);
    expect(settlePaymentMock).not.toHaveBeenCalled();
  });

  it('reports a refused settlement as false and logs the reason', async () => {
    settlePaymentMock.mockResolvedValue({ error: 'Insufficient MJN balance', status: 400 });

    await expect(settleQueryCost({ ...base, log, logFailureMessage: 'settle failed' })).resolves.toBe(false);

    expect(log.error).toHaveBeenCalledWith({ err: 'Insufficient MJN balance' }, 'settle failed');
  });

  it('reports a refused settlement as false silently when the caller passed no logger', async () => {
    settlePaymentMock.mockResolvedValue({ error: 'nope', status: 400 });
    await expect(settleQueryCost(base)).resolves.toBe(false);
    expect(log.error).not.toHaveBeenCalled();
  });

  it('never throws: a crash is false, logged when the caller asked for it', async () => {
    settlePaymentMock.mockRejectedValue(new Error('db down'));

    await expect(settleQueryCost({ ...base, log, logErrorMessage: 'settle errored' })).resolves.toBe(false);
    expect(log.error).toHaveBeenCalledWith({ err: 'Error: db down' }, 'settle errored');

    await expect(settleQueryCost(base)).resolves.toBe(false);
  });
});
