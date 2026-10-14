import { afterEach, describe, expect, it, vi } from 'vitest';

const { emitMock } = vi.hoisted(() => ({ emitMock: vi.fn() }));
vi.mock('../emission-core', () => ({ emitMjnx: emitMock }));

import { getEmissionExecutor, registerEmissionExecutor } from '@imajin/bus';
import { ensureEmissionExecutorRegistered, kernelEmissionExecutor } from '../emission-executor';

afterEach(() => {
  registerEmissionExecutor(null);
  vi.clearAllMocks();
});

describe('kernel emission executor (#2735)', () => {
  it('registers idempotently and repairs a replaced executor', () => {
    expect(getEmissionExecutor()).toBeUndefined();
    ensureEmissionExecutorRegistered();
    expect(getEmissionExecutor()).toBe(kernelEmissionExecutor);
    ensureEmissionExecutorRegistered();
    expect(getEmissionExecutor()).toBe(kernelEmissionExecutor);
    registerEmissionExecutor(async () => ({ error: 'other', status: 500 }));
    ensureEmissionExecutorRegistered();
    expect(getEmissionExecutor()).toBe(kernelEmissionExecutor);
  });

  it('delegates the unchanged parameters and result to the ledger core', async () => {
    const params = {
      to_did: 'did:imajin:subject', amount: 10, unit: 'MJNx', reason: 'Welcome',
      metadata: { idempotency_key: 'emission:att_1:0:subject' },
    };
    const result = { id: 'tx_1', amount: '10', to_did: params.to_did, status: 'completed' };
    emitMock.mockResolvedValue(result);
    ensureEmissionExecutorRegistered();
    expect(await getEmissionExecutor()!(params)).toBe(result);
    expect(emitMock).toHaveBeenCalledWith(params);
  });

  it('propagates storage failures for the reactor to retry', async () => {
    emitMock.mockRejectedValue(new Error('database unavailable'));
    await expect(kernelEmissionExecutor({
      to_did: 'did:imajin:subject', amount: 10, unit: 'MJNx', reason: 'Welcome',
    })).rejects.toThrow('database unavailable');
  });
});
