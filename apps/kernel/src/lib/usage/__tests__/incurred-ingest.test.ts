import { describe, it, expect } from 'vitest';
import { validateIncurredBatch, deriveProviderModel, deriveQuantityUnit, MAX_INCURRED_BATCH_SIZE } from '../incurred-ingest';

function row(overrides: Record<string, unknown> = {}) {
  return {
    source: 'adapter:claude-code',
    resource: 'model:anthropic/claude-sonnet-4-5',
    external_id: 'msg_abc123',
    ts: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('validateIncurredBatch — envelope', () => {
  it('rejects a non-array body', () => {
    expect(validateIncurredBatch({})).toEqual({ error: 'body must be an array of rows' });
  });

  it('rejects an empty batch', () => {
    expect(validateIncurredBatch([])).toEqual({ error: 'body must not be empty' });
  });

  it('rejects a batch over the size ceiling', () => {
    const rows = Array.from({ length: MAX_INCURRED_BATCH_SIZE + 1 }, () => row());
    expect(validateIncurredBatch(rows)).toEqual({
      error: `body may not exceed ${MAX_INCURRED_BATCH_SIZE} rows per request`,
    });
  });

  it('accepts a batch at exactly the size ceiling', () => {
    const rows = Array.from({ length: MAX_INCURRED_BATCH_SIZE }, (_, i) => row({ external_id: `msg_${i}` }));
    const result = validateIncurredBatch(rows);
    expect('accepted' in result && result.accepted).toHaveLength(MAX_INCURRED_BATCH_SIZE);
  });
});

describe('validateIncurredBatch — per-row validation', () => {
  it('accepts a well-formed row and normalizes it', () => {
    const result = validateIncurredBatch([row({ tokens_in: 100, tokens_out: 20, cost_usd: 0.001, provider: 'anthropic', model: 'claude-sonnet-4-5' })]);
    expect('accepted' in result).toBe(true);
    if (!('accepted' in result)) throw new Error('expected accepted batch');
    expect(result.rejected).toEqual([]);
    expect(result.accepted).toEqual([
      {
        index: 0,
        source: 'adapter:claude-code',
        resource: 'model:anthropic/claude-sonnet-4-5',
        provider: 'anthropic',
        model: 'claude-sonnet-4-5',
        tokensIn: 100,
        tokensOut: 20,
        costUsd: 0.001,
        externalId: 'msg_abc123',
        ts: new Date('2026-01-01T00:00:00.000Z'),
      },
    ]);
  });

  it('validates and normalizes an explicit quantity/unit pair (#1148)', () => {
    const result = validateIncurredBatch([row({ quantity: 3, unit: 'calls' })]);
    if (!('accepted' in result)) throw new Error('expected accepted batch');
    expect(result.rejected).toEqual([]);
    expect(result.accepted[0]).toMatchObject({ quantity: 3, unit: 'calls' });
  });

  it('rejects a non-numeric quantity', () => {
    const result = validateIncurredBatch([row({ quantity: 'a lot' })]);
    if (!('accepted' in result)) throw new Error('expected accepted batch');
    expect(result.rejected).toEqual([{ index: 0, reason: 'quantity must be a number when present' }]);
  });

  it('rejects a non-string unit', () => {
    const result = validateIncurredBatch([row({ unit: 42 })]);
    if (!('accepted' in result)) throw new Error('expected accepted batch');
    expect(result.rejected).toEqual([{ index: 0, reason: 'unit must be a string when present' }]);
  });

  it('carries an optional acting_for through', () => {
    const result = validateIncurredBatch([row({ acting_for: 'did:imajin:someone' })]);
    if (!('accepted' in result)) throw new Error('expected accepted batch');
    expect(result.accepted[0].actingFor).toBe('did:imajin:someone');
  });

  it('rejects a non-object row', () => {
    const result = validateIncurredBatch(['not an object']);
    if (!('accepted' in result)) throw new Error('expected accepted batch');
    expect(result.rejected).toEqual([{ index: 0, reason: 'row must be an object' }]);
  });

  it('rejects a missing source', () => {
    const result = validateIncurredBatch([row({ source: undefined })]);
    if (!('accepted' in result)) throw new Error('expected accepted batch');
    expect(result.rejected).toEqual([{ index: 0, reason: 'source must be a non-empty string' }]);
  });

  it.each(['bogus', 'model', 'model:', 'tool'])('rejects a malformed resource %s', (resource) => {
    const result = validateIncurredBatch([row({ resource })]);
    if (!('accepted' in result)) throw new Error('expected accepted batch');
    expect(result.rejected).toEqual([
      { index: 0, reason: "resource must be shaped 'model:*' | 'tool:*' | 'infra:*' | 'external:*'" },
    ]);
  });

  it.each(['tool:linter', 'infra:compute', 'external:sms'])('accepts non-model resource %s', (resource) => {
    const result = validateIncurredBatch([row({ resource })]);
    if (!('accepted' in result)) throw new Error('expected accepted batch');
    expect(result.rejected).toEqual([]);
    expect(result.accepted[0].resource).toBe(resource);
  });

  it('rejects a missing external_id', () => {
    const result = validateIncurredBatch([row({ external_id: undefined })]);
    if (!('accepted' in result)) throw new Error('expected accepted batch');
    expect(result.rejected).toEqual([{ index: 0, reason: 'external_id must be a non-empty string (the dedupe key)' }]);
  });

  it('rejects an invalid ts', () => {
    const result = validateIncurredBatch([row({ ts: 'not-a-date' })]);
    if (!('accepted' in result)) throw new Error('expected accepted batch');
    expect(result.rejected).toEqual([{ index: 0, reason: 'ts must be a valid ISO 8601 timestamp' }]);
  });

  it('rejects a non-numeric tokens_in', () => {
    const result = validateIncurredBatch([row({ tokens_in: 'lots' })]);
    if (!('accepted' in result)) throw new Error('expected accepted batch');
    expect(result.rejected).toEqual([{ index: 0, reason: 'tokens_in must be a number when present' }]);
  });

  it('reports accepted and rejected independently across a mixed batch', () => {
    const result = validateIncurredBatch([row({ external_id: 'a' }), row({ source: undefined }), row({ external_id: 'c' })]);
    if (!('accepted' in result)) throw new Error('expected accepted batch');
    expect(result.accepted).toHaveLength(2);
    expect(result.accepted.map((r) => r.index)).toEqual([0, 2]);
    expect(result.rejected).toEqual([{ index: 1, reason: 'source must be a non-empty string' }]);
  });
});

describe('deriveProviderModel', () => {
  it('prefers explicit provider/model when both are present', () => {
    expect(deriveProviderModel({ resource: 'model:anthropic/claude-sonnet-4-5', provider: 'explicit-provider', model: 'explicit-model' })).toEqual({
      provider: 'explicit-provider',
      model: 'explicit-model',
    });
  });

  it('parses provider/model out of a model:* resource when omitted', () => {
    expect(deriveProviderModel({ resource: 'model:anthropic/claude-sonnet-4-5' })).toEqual({
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
    });
  });

  it('falls back to the resource kind/value for a non-model resource', () => {
    expect(deriveProviderModel({ resource: 'tool:linter' })).toEqual({ provider: 'tool', model: 'linter' });
  });

  it('falls back to the whole resource as model when there is no value segment', () => {
    expect(deriveProviderModel({ resource: 'external:sms:reminder' })).toEqual({ provider: 'external', model: 'sms:reminder' });
  });
});

describe('deriveQuantityUnit', () => {
  it('honors an explicit quantity/unit pair over token counts', () => {
    expect(deriveQuantityUnit({ quantity: 3, unit: 'calls', tokensIn: 100, tokensOut: 20 })).toEqual({ quantity: 3, unit: 'calls' });
  });

  it('honors an explicit quantity with no unit, without inventing one', () => {
    expect(deriveQuantityUnit({ quantity: 3, unit: undefined, tokensIn: undefined, tokensOut: undefined })).toEqual({
      quantity: 3,
      unit: undefined,
    });
  });

  it('derives quantity/unit from tokensIn + tokensOut when neither is sent explicitly (matches usage-ledger.ts)', () => {
    expect(deriveQuantityUnit({ quantity: undefined, unit: undefined, tokensIn: 100, tokensOut: 20 })).toEqual({
      quantity: 120,
      unit: 'tokens',
    });
  });

  it('does not overwrite an explicit unit when deriving quantity from tokens', () => {
    expect(deriveQuantityUnit({ quantity: undefined, unit: 'requests', tokensIn: 100, tokensOut: 20 })).toEqual({
      quantity: 120,
      unit: 'requests',
    });
  });

  it('derives nothing when quantity is absent and token counts are incomplete', () => {
    expect(deriveQuantityUnit({ quantity: undefined, unit: undefined, tokensIn: 100, tokensOut: undefined })).toEqual({
      quantity: undefined,
      unit: undefined,
    });
  });
});
