import { describe, it, expect, beforeEach, vi } from 'vitest';

const { calls, cacheRows, fakeSql } = vi.hoisted(() => {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  /** cacheKey -> stored row, standing in for auth.attestations. */
  const cacheRows = new Map<string, Record<string, unknown>>();
  const fakeSql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.join(' ? '), values });
    const row = cacheRows.get(String(values[1]));
    return Promise.resolve(row ? [row] : []);
  };
  return { calls, cacheRows, fakeSql };
});

vi.mock('@imajin/db', () => ({ getClient: () => fakeSql }));

import {
  brokerPredicateCacheKey,
  resolveBrokerPredicateClaimsForField,
} from '../src/predicate-claims';

const SUBJECT = 'did:imajin:traveler';

/** Seed a live cache row the way the release reactor would have persisted one. */
function seedCachedContains(field: string, term: string, result: boolean): string {
  const cacheKey = brokerPredicateCacheKey({ subject: SUBJECT, field, predicate: 'contains', arg: term });
  cacheRows.set(cacheKey, {
    payload: {
      field,
      predicate: 'contains',
      arg: term,
      result,
      valueHash: 'seeded',
      cacheKey,
      issuedAt: '2026-08-05T00:00:00.000Z',
      expiresAt: '2026-08-05T01:00:00.000Z',
    },
    issued_at: '2026-08-05T00:00:00.000Z',
    expires_at: '2026-08-05T01:00:00.000Z',
  });
  return cacheKey;
}

beforeEach(() => {
  calls.length = 0;
  cacheRows.clear();
});

describe('scalar and contains predicates', () => {
  it('evaluates set predicates using canonical term normalization', async () => {
    const { claims, cacheWrites } = await resolveBrokerPredicateClaimsForField({
      subject: SUBJECT,
      field: 'allergies',
      value: 'peanuts; shellfish',
      predicates: { predicate: 'contains', arg: 'arachis' },
      now: new Date('2026-08-05T00:00:00.000Z'),
    });

    expect(claims[0]).toEqual(expect.objectContaining({
      field: 'allergies',
      predicate: 'contains',
      arg: 'peanut',
      result: true,
      issuedAt: '2026-08-05T00:00:00.000Z',
      expiresAt: '2026-08-05T01:00:00.000Z',
    }));
    expect(claims[0].valueHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(claims[0])).not.toContain('shellfish');
    // A freshly evaluated primitive is offered for caching.
    expect(cacheWrites).toEqual([claims[0]]);
  });

  it('uses a live cached claim instead of re-evaluating the raw value', async () => {
    const cacheKey = seedCachedContains('allergies', 'peanut', true);

    const { claims, cacheWrites } = await resolveBrokerPredicateClaimsForField({
      subject: SUBJECT,
      field: 'allergies',
      // Deliberately contradicts the cached row: re-evaluation would yield
      // false, so `true` proves the cached claim was used.
      value: 'shellfish',
      predicates: { predicate: 'contains', arg: 'peanut' },
    });

    expect(claims[0]).toEqual(expect.objectContaining({
      cacheKey,
      cached: true,
      result: true,
      valueHash: 'seeded',
    }));
    expect(calls).toHaveLength(1);
    expect(calls[0].values).toEqual([SUBJECT, cacheKey]);
    // Nothing to re-persist on a cache hit.
    expect(cacheWrites).toEqual([]);
  });

  it('re-evaluates when no live cache row is returned', async () => {
    const { claims, cacheWrites } = await resolveBrokerPredicateClaimsForField({
      subject: SUBJECT,
      field: 'allergies',
      value: 'shellfish',
      predicates: { predicate: 'contains', arg: 'peanut' },
    });

    expect(claims[0].cached).toBeUndefined();
    expect(claims[0].result).toBe(false);
    expect(cacheWrites).toHaveLength(1);
  });

  it('rejects a predicate the field does not allow', async () => {
    await expect(resolveBrokerPredicateClaimsForField({
      subject: SUBJECT,
      field: 'allergies',
      value: 'peanut',
      predicates: { predicate: 'gte', arg: 3 },
    })).rejects.toThrow(/not allowed for broker field allergies/);
  });
});

// ── #1514: overlaps decomposes onto the warm contains cache ──────────────────

describe('overlaps decomposition', () => {
  it('decomposes into one cached contains primitive per declared term', async () => {
    const { claims, cacheWrites } = await resolveBrokerPredicateClaimsForField({
      subject: SUBJECT,
      field: 'allergies',
      value: 'peanuts; shellfish',
      predicates: { predicate: 'overlaps', arg: ['peanut', 'egg', 'wheat'] },
      now: new Date('2026-08-05T00:00:00.000Z'),
    });

    // One cache lookup per declared term; the composition itself is not looked up.
    expect(calls).toHaveLength(3);

    // Every persisted row is a single-term `contains` primitive, never `overlaps`.
    expect(cacheWrites).toHaveLength(3);
    expect(cacheWrites.map((claim) => claim.predicate)).toEqual(['contains', 'contains', 'contains']);
    expect(cacheWrites.map((claim) => claim.arg)).toEqual(['peanut', 'egg', 'wheat']);

    // The requester gets one composed boolean.
    expect(claims).toHaveLength(1);
    expect(claims[0]).toEqual(expect.objectContaining({
      field: 'allergies',
      predicate: 'overlaps',
      arg: ['peanut', 'egg', 'wheat'],
      result: true,
    }));

    // Provenance references the primitives it consumed, by cache key.
    expect(claims[0].composedFrom).toEqual(cacheWrites.map((claim) => claim.cacheKey));
  });

  it('evaluates every declared term rather than short-circuiting on the first match', async () => {
    // `peanut` matches, so a short-circuiting implementation would stop there
    // and leave `egg` cold for the next requester.
    const { cacheWrites } = await resolveBrokerPredicateClaimsForField({
      subject: SUBJECT,
      field: 'allergies',
      value: 'peanut',
      predicates: { predicate: 'overlaps', arg: ['peanut', 'egg'] },
    });

    expect(cacheWrites.map((claim) => claim.arg)).toEqual(['peanut', 'egg']);
  });

  it('never discloses which declared term matched', async () => {
    const { claims } = await resolveBrokerPredicateClaimsForField({
      subject: SUBJECT,
      field: 'allergies',
      value: 'peanuts',
      predicates: { predicate: 'overlaps', arg: ['peanut', 'egg'] },
    });

    // Only the composed boolean crosses. No per-term results appear in the claim
    // handed back, so the requester cannot learn it was `peanut` specifically.
    expect(claims[0].result).toBe(true);
    expect(JSON.stringify(claims[0])).not.toContain('"contains"');
    expect(claims[0].composedFrom?.every((key) => key.startsWith('broker.predicate.'))).toBe(true);
  });

  it('deduplicates repeated declared terms and canonicalizes aliases', async () => {
    const { claims, cacheWrites } = await resolveBrokerPredicateClaimsForField({
      subject: SUBJECT,
      field: 'allergies',
      value: 'shellfish',
      predicates: { predicate: 'overlaps', arg: ['peanuts', 'arachis', 'PEANUT'] },
    });

    // All three aliases collapse to one canonical term, so one primitive.
    expect(cacheWrites).toHaveLength(1);
    expect(cacheWrites[0].arg).toBe('peanut');
    expect(claims[0].arg).toEqual(['peanut']);
    expect(claims[0].result).toBe(false);
  });

  it('returns false for an empty declared set without touching the cache', async () => {
    const { claims, cacheWrites } = await resolveBrokerPredicateClaimsForField({
      subject: SUBJECT,
      field: 'allergies',
      value: 'peanuts',
      predicates: { predicate: 'overlaps', arg: [] },
    });

    expect(calls).toEqual([]);
    expect(cacheWrites).toEqual([]);
    expect(claims[0].result).toBe(false);
    expect(claims[0].composedFrom).toEqual([]);
  });

  it('reuses the warm contains cache across requesters with different declared sets', async () => {
    // Requester A warms `peanut` and `egg`.
    const first = await resolveBrokerPredicateClaimsForField({
      subject: SUBJECT,
      field: 'allergies',
      value: 'peanuts; shellfish',
      predicates: { predicate: 'overlaps', arg: ['peanut', 'egg'] },
    });
    expect(first.cacheWrites.map((claim) => claim.arg)).toEqual(['peanut', 'egg']);

    // Persist what A evaluated, as the release reactor would.
    for (const claim of first.cacheWrites) {
      seedCachedContains('allergies', String(claim.arg), claim.result);
    }
    calls.length = 0;

    // Requester B declares a different dish that happens to share `peanut`.
    const second = await resolveBrokerPredicateClaimsForField({
      subject: SUBJECT,
      field: 'allergies',
      value: 'peanuts; shellfish',
      predicates: { predicate: 'overlaps', arg: ['peanut', 'milk'] },
    });

    // `peanut` came from the warm cache; only the genuinely new term was evaluated.
    // Under the previous whole-set cache key this would have been a total miss.
    expect(calls).toHaveLength(2);
    expect(second.cacheWrites.map((claim) => claim.arg)).toEqual(['milk']);
    expect(second.claims[0].result).toBe(true);
    expect(second.claims[0].composedFrom).toHaveLength(2);
  });
});
