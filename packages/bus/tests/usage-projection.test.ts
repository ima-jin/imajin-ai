import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BusEvent } from '../src/types';

const { calls, fakeSql } = vi.hoisted(() => {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const fakeSql = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.join(' ? '), values });
    return [];
  });
  return { calls, fakeSql };
});
vi.mock('@imajin/db', () => ({ getClient: () => fakeSql }));
import { usageProjectionReactor } from '../src/reactors/usage-projection';
import { getChainConfig } from '../src/config';

function receipt(payload: Record<string, unknown> = {}): BusEvent {
  return {
    type: 'usage.incurred', issuer: 'did:imajin:node', subject: 'did:imajin:org', scope: 'usage',
    payload: {
      usageId: 'usage_receipt', actingFor: 'did:imajin:org',
      source: 'typesafe-decide', resource: 'model:typesafe/jev', provider: 'typesafe', model: 'jev',
      agentDid: 'did:imajin:delegated-agent', connectorId: 'conn_org_typesafe',
      tokensIn: 100, tokensOut: 0, quantity: 100, unit: 'tokens', costEstimateUsd: 0.0000042,
      sessionId: 'session-1', turnId: 'turn-1', externalId: 'upstream-1', transactionId: null,
      ts: '2026-10-01T12:34:56.789Z', ...payload,
    },
  };
}

beforeEach(() => {
  calls.length = 0;
  fakeSql.mockClear();
});

describe('usageProjectionReactor', () => {
  it('writes the row solely from the receipt, including delegated identity and receipt time', async () => {
    await usageProjectionReactor(receipt({ pricing: { unit: 'USD', source: 'meter' }, status: 'error' }), {});
    expect(calls).toHaveLength(1);
    expect(calls[0].text).toContain('INSERT INTO usage.incurred');
    expect(calls[0].text).toContain('ON CONFLICT (id) DO NOTHING');
    expect(calls[0].text).not.toContain('now()');
    expect(calls[0].values).toEqual([
      'usage_receipt', 'did:imajin:org', 'typesafe-decide', 'model:typesafe/jev', 'typesafe', 'jev',
      'session-1', 'turn-1', 'did:imajin:delegated-agent', 'conn_org_typesafe', 100, 0,
      '0.00000420', '100.000000', 'tokens', null, 'upstream-1', 'error',
      JSON.stringify({ unit: 'USD', source: 'meter' }), '2026-10-01T12:34:56.789Z',
    ]);
  });

  it('maps omitted optional columns to NULL, while preserving known zeroes', async () => {
    const event = receipt();
    for (const field of ['sessionId', 'turnId', 'agentDid', 'connectorId', 'tokensIn', 'tokensOut',
      'quantity', 'unit', 'costEstimateUsd', 'transactionId', 'externalId']) delete event.payload[field];
    await usageProjectionReactor(event, {});
    expect(calls[0].values.slice(6, 19)).toEqual(Array.from({ length: 13 }, () => null));
    await usageProjectionReactor(receipt({ quantity: 0, costEstimateUsd: 0 }), {});
    expect(calls[1].values.slice(12, 14)).toEqual(['0.00000000', '0.000000']);
  });

  it.each(['usageId', 'actingFor', 'source', 'resource', 'provider', 'model', 'ts'])(
    'rejects missing, empty, and non-string %s before SQL', async (field) => {
      for (const value of [undefined, null, '', ' ', 42]) {
        await expect(usageProjectionReactor(receipt({ [field]: value }), {})).rejects.toBeInstanceOf(TypeError);
      }
      expect(calls).toHaveLength(0);
    },
  );
  it('rejects an invalid receipt timestamp without falling back to event time', async () => {
    await expect(usageProjectionReactor({ ...receipt({ ts: 'yesterday-ish' }), timestamp: new Date().toISOString() }, {}))
      .rejects.toThrow('ts must be a valid timestamp');
    expect(calls).toHaveLength(0);
  });
  it('rejects a missing payload', async () => {
    await expect(usageProjectionReactor({ ...receipt(), payload: undefined } as unknown as BusEvent, {}))
      .rejects.toBeInstanceOf(TypeError);
    expect(calls).toHaveLength(0);
  });
  it.each(['sessionId', 'turnId', 'agentDid', 'connectorId', 'unit', 'transactionId', 'externalId', 'status'])(
    'rejects malformed optional string %s', async (field) => {
      for (const value of [false, 12, '', ' ']) {
        await expect(usageProjectionReactor(receipt({ [field]: value }), {})).rejects.toBeInstanceOf(TypeError);
      }
      expect(calls).toHaveLength(0);
    },
  );
  it.each(['quantity', 'costEstimateUsd', 'tokensIn', 'tokensOut'])('rejects invalid numeric %s', async (field) => {
    for (const value of [-1, Number.NaN, Number.POSITIVE_INFINITY, '10']) {
      await expect(usageProjectionReactor(receipt({ [field]: value }), {})).rejects.toBeInstanceOf(TypeError);
    }
    expect(calls).toHaveLength(0);
  });
  it.each(['tokensIn', 'tokensOut'])('rejects fractional or overflowing %s', async (field) => {
    for (const value of [1.5, 2_147_483_648]) {
      await expect(usageProjectionReactor(receipt({ [field]: value }), {})).rejects.toThrow('SQL integer');
    }
    expect(calls).toHaveLength(0);
  });
  it.each([[], 'pricing', 1, false])('rejects malformed pricing %j', async (pricing) => {
    await expect(usageProjectionReactor(receipt({ pricing }), {})).rejects.toThrow('pricing must be an object');
    expect(calls).toHaveLength(0);
  });
  it('ignores unrelated events', async () => {
    await usageProjectionReactor({ ...receipt(), type: 'usage.rollup' }, {});
    expect(calls).toHaveLength(0);
  });
  it('propagates database failures to the framework', async () => {
    fakeSql.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(usageProjectionReactor(receipt(), {})).rejects.toThrow('database unavailable');
  });
  it('adds a non-awaited projection without changing attestation or emit defaults', async () => {
    const chain = await getChainConfig('usage.incurred', 'usage');
    expect(chain.reactors).toEqual([
      { type: 'attestation', config: { attestationType: 'usage.incurred' }, enabled: true },
      { type: 'emit', config: {}, enabled: true },
      { type: 'usage-projection', config: {}, enabled: true },
    ]);
  });

});
