import { describe, it, expect, vi } from 'vitest';

// `brain.ts` pulls in `@/src/db` (a real drizzle client) purely to build error
// messages. The tests only need the error TYPES for `instanceof` matching, so
// the mock re-implements just enough shape to avoid a live DB client at
// test-import time — same pattern the capture route test already uses.
vi.mock('@/src/lib/inference/brain', () => {
  class NoBrainSealedError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'NoBrainSealedError';
    }
  }
  class NoModelSelectedError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'NoModelSelectedError';
    }
  }
  class ModelDeprecatedError extends Error {
    readonly connector: string;
    readonly modelId: string;
    constructor(connector: string, modelId: string) {
      super(`model_deprecated: ${connector} model '${modelId}' was not found upstream`);
      this.name = 'ModelDeprecatedError';
      this.connector = connector;
      this.modelId = modelId;
    }
  }
  return { NoBrainSealedError, NoModelSelectedError, ModelDeprecatedError };
});

import { mapBrainErrorToHttp } from '../brain-http-errors';
import { NoBrainSealedError, NoModelSelectedError, ModelDeprecatedError } from '@/src/lib/inference/brain';
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
});
