/**
 * Kernel → bus hook-up for the `settle` reactor (#2642): the executor handed to
 * the bus IS `settlePayment()`, and registration is idempotent.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const { settlePaymentMock } = vi.hoisted(() => ({ settlePaymentMock: vi.fn() }));
vi.mock('../settle-core', () => ({ settlePayment: settlePaymentMock }));

import { getSettleExecutor, registerSettleExecutor } from '@imajin/bus';
import { ensureSettleExecutorRegistered, kernelSettleExecutor } from '../settle-executor';

afterEach(() => {
  registerSettleExecutor(null);
  vi.clearAllMocks();
});

describe('kernel settle executor (#2642)', () => {
  it('registers the kernel executor with the bus, idempotently', () => {
    expect(getSettleExecutor()).toBeUndefined();

    ensureSettleExecutorRegistered();
    expect(getSettleExecutor()).toBe(kernelSettleExecutor);

    ensureSettleExecutorRegistered();
    expect(getSettleExecutor()).toBe(kernelSettleExecutor);
  });

  it('re-registers when something else replaced it', () => {
    registerSettleExecutor(async () => ({ error: 'other', status: 500 }));

    ensureSettleExecutorRegistered();

    expect(getSettleExecutor()).toBe(kernelSettleExecutor);
  });

  it('delegates to settlePayment() unchanged', async () => {
    const params = {
      from_did: 'did:imajin:buyer',
      total_amount: 10,
      service: 'market',
      type: 'sale',
      fair_manifest: { chain: [{ did: 'did:imajin:seller', amount: 10, role: 'seller' }] },
    };
    settlePaymentMock.mockResolvedValue({ settled: true, batchId: 'batch_1', transactions: [], total_amount: 10, recipients: 1, source: 'fiat' });

    const result = await kernelSettleExecutor(params);

    expect(settlePaymentMock).toHaveBeenCalledWith(params);
    expect(result).toMatchObject({ settled: true, batchId: 'batch_1' });
  });
});
