import { describe, it, expect, beforeEach, vi } from 'vitest';

const { calls, nextRows, fakeSql } = vi.hoisted(() => {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const nextRows: unknown[][] = [];
  const fakeSql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.join(' ? '), values });
    return Promise.resolve(nextRows.shift() ?? []);
  };
  return { calls, nextRows, fakeSql };
});

vi.mock('@imajin/db', () => ({ getClient: () => fakeSql }));

import {
  brokerPredicateCacheKey,
  resolveBrokerPredicateClaimsForField,
} from '../src/predicate-claims';

describe('broker predicate claims', () => {
  beforeEach(() => {
    calls.length = 0;
    nextRows.length = 0;
  });

  it('evaluates set predicates using canonical term normalization', async () => {
    nextRows.push([]);
    const [claim] = await resolveBrokerPredicateClaimsForField({
      subject: 'did:imajin:traveler',
      field: 'allergies',
      value: 'peanuts; shellfish',
      predicates: { predicate: 'contains', arg: 'arachis' },
      now: new Date('2026-08-05T00:00:00.000Z'),
    });

    expect(claim).toEqual(expect.objectContaining({
      field: 'allergies',
      predicate: 'contains',
      arg: 'peanut',
      result: true,
      issuedAt: '2026-08-05T00:00:00.000Z',
      expiresAt: '2026-08-05T01:00:00.000Z',
    }));
    expect(claim.valueHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(claim)).not.toContain('shellfish');
  });

  it('uses a live cached claim instead of re-evaluating the raw value', async () => {
    const cacheKey = brokerPredicateCacheKey({
      subject: 'did:imajin:traveler',
      field: 'allergies',
      predicate: 'contains',
      arg: 'peanut',
    });
    nextRows.push([{
      payload: {
        field: 'allergies',
        predicate: 'contains',
        arg: 'peanut',
        result: true,
        valueHash: 'cached',
        cacheKey,
        issuedAt: '2026-08-05T00:00:00.000Z',
        expiresAt: '2026-08-05T01:00:00.000Z',
      },
      issued_at: '2026-08-05T00:00:00.000Z',
      expires_at: '2026-08-05T01:00:00.000Z',
    }]);

    const [claim] = await resolveBrokerPredicateClaimsForField({
      subject: 'did:imajin:traveler',
      field: 'allergies',
      value: 'shellfish',
      predicates: { predicate: 'contains', arg: 'peanut' },
    });

    expect(claim).toEqual(expect.objectContaining({
      cacheKey,
      cached: true,
      result: true,
      valueHash: 'cached',
    }));
    expect(calls).toHaveLength(1);
    expect(calls[0].values).toEqual(['did:imajin:traveler', cacheKey]);
  });

  it('re-evaluates when no live cache row is returned', async () => {
    nextRows.push([]);
    const [claim] = await resolveBrokerPredicateClaimsForField({
      subject: 'did:imajin:traveler',
      field: 'allergies',
      value: 'shellfish',
      predicates: { predicate: 'contains', arg: 'peanut' },
    });

    expect(claim.cached).toBeUndefined();
    expect(claim.result).toBe(false);
  });
});
