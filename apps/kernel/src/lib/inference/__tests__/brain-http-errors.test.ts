import { describe, it, expect, vi } from 'vitest';

// `brain.ts` pulls in `@/src/db` (a real drizzle client) purely to build error
// messages. The tests only need the error TYPES for `instanceof` matching, so
// the mock re-implements just enough shape to avoid a live DB client at
// test-import time — see `brain-errors-test-support.ts` for the shared shape.
vi.mock('@/src/lib/inference/brain', async () => {
  const { createFakeBrainErrorClasses } = await import('./brain-errors-test-support');
  return createFakeBrainErrorClasses();
});

// `spend-cap.ts` pulls in `@/src/db` (a real drizzle client) to sum
// `usage.incurred` rows. Only the error TYPE is needed here — see
// `createFakeSpendCapClasses` in `brain-errors-test-support.ts`.
vi.mock('@/src/lib/inference/spend-cap', async () => {
  const { createFakeSpendCapClasses } = await import('./brain-errors-test-support');
  return createFakeSpendCapClasses();
});

import { mapBrainErrorToHttp } from '../brain-http-errors';
import { NoBrainSealedError, NoModelSelectedError, ModelDeprecatedError } from '@/src/lib/inference/brain';
import { SpendCapExceededError } from '@/src/lib/inference/spend-cap';
import { VaultDelegationError } from '@/src/lib/vault/errors';
import { RetryError } from 'ai';

describe('mapBrainErrorToHttp', () => {
  it('maps NoBrainSealedError to a 422 no_brain response with no credential material', () => {
    const err = new NoBrainSealedError('inference_no_brain: no model credential sealed for did:imajin:x');
    const mapped = mapBrainErrorToHttp(err);
    expect(mapped).toEqual({
      status: 422,
      body: expect.objectContaining({ error: 'no_brain', message: expect.stringContaining('connect') }),
    });
    expect(JSON.stringify(mapped)).not.toMatch(/sk-|AIzaSy/);
  });

  it('maps NoModelSelectedError to a 422 no_model_selected response', () => {
    const err = new NoModelSelectedError('Gemini is connected but no model is selected');
    const mapped = mapBrainErrorToHttp(err);
    expect(mapped).toEqual({
      status: 422,
      body: expect.objectContaining({ error: 'no_model_selected', message: expect.stringContaining('no model is selected') }),
    });
  });

  it('maps ModelDeprecatedError to a 422 model_deprecated response naming the connector/model', () => {
    const err = new ModelDeprecatedError('gemini', 'gemini-2.5-flash');
    const mapped = mapBrainErrorToHttp(err);
    expect(mapped).toEqual({
      status: 422,
      body: expect.objectContaining({ error: 'model_deprecated', connector: 'gemini', modelId: 'gemini-2.5-flash' }),
    });
  });

  it('maps an exhausted RetryError with a rate-limit message to a 429 rate_limited response', () => {
    const err = new RetryError({
      message: 'Failed after 3 attempts. Last error: Too Many Requests',
      reason: 'maxRetriesExceeded',
      errors: [new Error('Too Many Requests')],
    });
    const mapped = mapBrainErrorToHttp(err);
    expect(mapped).toEqual({
      status: 429,
      body: expect.objectContaining({ error: 'rate_limited', message: expect.stringContaining('rate limit') }),
    });
  });

  it('does not map a RetryError unrelated to rate limiting', () => {
    const err = new RetryError({
      message: 'Failed after 3 attempts. Last error: Internal Server Error',
      reason: 'maxRetriesExceeded',
      errors: [new Error('Internal Server Error')],
    });
    expect(mapBrainErrorToHttp(err)).toBeUndefined();
  });

  it('maps VaultDelegationError to a 503 credential_pending response', () => {
    const err = new VaultDelegationError('No active delegation grant', {
      field: 'gemini-api-key:did:imajin:supplier',
      nodeDid: 'did:imajin:supplier',
    });
    const mapped = mapBrainErrorToHttp(err);
    expect(mapped).toEqual({ status: 503, body: expect.objectContaining({ error: 'credential_pending' }) });
  });

  it('returns undefined for an unrecognized error', () => {
    expect(mapBrainErrorToHttp(new Error('storage offline'))).toBeUndefined();
    expect(mapBrainErrorToHttp('not even an error')).toBeUndefined();
  });

  it('maps SpendCapExceededError to a 402 spend_cap_exceeded response naming the cap and spend (#1923)', () => {
    const err = new SpendCapExceededError('conn_x', { amountUsd: 25, period: 'monthly' }, 30);
    const mapped = mapBrainErrorToHttp(err);
    expect(mapped).toEqual({
      status: 402,
      body: expect.objectContaining({ error: 'spend_cap_exceeded', spentUsd: 30, capUsd: 25, period: 'monthly' }),
    });
  });
});
