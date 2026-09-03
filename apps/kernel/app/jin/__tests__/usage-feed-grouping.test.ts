/**
 * Tests for the /jin usage feed panel's pure helpers (#1864): session
 * grouping, delta-tone classification, id truncation, and cost formatting.
 */
import { describe, it, expect } from 'vitest';
import { groupBySession, deltaTone, truncateId, formatCost, isTurnUsageRowArray, type TurnUsageRow } from '../usage-feed-grouping';

function row(overrides: Partial<TurnUsageRow> = {}): TurnUsageRow {
  return {
    id: 'att_1',
    issuedAt: '2026-08-18T22:55:00.000Z',
    sessionKey: 's1',
    model: 'anthropic/claude-opus-4-6',
    tokensIn: 100,
    tokensOut: 50,
    tokenDelta: 0,
    sessionTokensIn: 100,
    sessionTokensOut: 50,
    cost: { input: 0.1, output: 0.05, total: 0.15 },
    sessionCostTotal: 0.15,
    channel: 'telegram',
    durationMs: 1000,
    ...overrides,
  };
}

describe('groupBySession', () => {
  it('groups consecutive rows sharing a session key into one group', () => {
    const rows = [
      row({ id: 'newer', sessionKey: 's1', sessionTokensIn: 250, sessionTokensOut: 90, sessionCostTotal: 0.3 }),
      row({ id: 'older', sessionKey: 's1', sessionTokensIn: 100, sessionTokensOut: 50, sessionCostTotal: 0.15 }),
    ];

    const groups = groupBySession(rows);

    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe('s1');
    expect(groups[0].rows.map((r) => r.id)).toEqual(['newer', 'older']);
  });

  it("takes a group's totals from the newest (first-seen) row, not the oldest", () => {
    const rows = [
      row({ id: 'newer', sessionKey: 's1', sessionTokensIn: 250, sessionTokensOut: 90, sessionCostTotal: 0.3 }),
      row({ id: 'older', sessionKey: 's1', sessionTokensIn: 100, sessionTokensOut: 50, sessionCostTotal: 0.15 }),
    ];

    const [group] = groupBySession(rows);

    expect(group.totals).toEqual({ tokensIn: 250, tokensOut: 90, costTotal: 0.3 });
  });

  it('preserves newest-session-first group ordering from the input order', () => {
    const rows = [
      row({ id: 'a1', sessionKey: 'session-a' }),
      row({ id: 'b1', sessionKey: 'session-b' }),
      row({ id: 'a2', sessionKey: 'session-a' }),
    ];

    const groups = groupBySession(rows);

    expect(groups.map((g) => g.key)).toEqual(['session-a', 'session-b']);
    expect(groups[0].rows.map((r) => r.id)).toEqual(['a1', 'a2']);
  });

  it('treats rows with a null session key as their own singleton groups, never merged together', () => {
    const rows = [
      row({ id: 'lone1', sessionKey: null }),
      row({ id: 'lone2', sessionKey: null }),
    ];

    const groups = groupBySession(rows);

    expect(groups).toHaveLength(2);
    expect(groups[0].sessionKey).toBeNull();
    expect(groups[1].sessionKey).toBeNull();
    expect(groups[0].rows).toHaveLength(1);
    expect(groups[1].rows).toHaveLength(1);
  });

  it('returns an empty array for an empty feed', () => {
    expect(groupBySession([])).toEqual([]);
  });
});

describe('deltaTone', () => {
  it('classifies a positive delta as higher', () => {
    expect(deltaTone(500)).toBe('higher');
  });

  it('classifies a negative delta as lower', () => {
    expect(deltaTone(-500)).toBe('lower');
  });

  it('classifies a zero delta as first', () => {
    expect(deltaTone(0)).toBe('first');
  });
});

describe('truncateId', () => {
  it('leaves short values unchanged', () => {
    expect(truncateId('short-id')).toBe('short-id');
  });

  it('truncates a long value to head…tail with an ellipsis', () => {
    const did = 'did:imajin:ADEKFWc2pbTKzfgzA3q6yrc1rEPNeMEP71mkBbCan54k';
    const result = truncateId(did);

    expect(result).toBe('did:imajin…Can54k');
    expect(result.length).toBeLessThan(did.length);
  });
});

describe('formatCost', () => {
  it('formats a sub-cent cost to 4 decimal places', () => {
    expect(formatCost(0.0024)).toBe('$0.0024');
  });

  it('formats zero cost', () => {
    expect(formatCost(0)).toBe('$0.0000');
  });
});

describe('isTurnUsageRowArray', () => {
  it('accepts a well-formed array of rows', () => {
    expect(isTurnUsageRowArray([row()])).toBe(true);
  });

  it('accepts an empty array', () => {
    expect(isTurnUsageRowArray([])).toBe(true);
  });

  it('accepts null sessionKey/model/channel/durationMs (the endpoint\'s own optionality)', () => {
    expect(isTurnUsageRowArray([row({ sessionKey: null, model: null, channel: null, durationMs: null })])).toBe(true);
  });

  it('rejects a non-array response', () => {
    expect(isTurnUsageRowArray({ rows: [row()] })).toBe(false);
    expect(isTurnUsageRowArray(null)).toBe(false);
    expect(isTurnUsageRowArray(undefined)).toBe(false);
  });

  it('rejects an array containing a null or non-object element', () => {
    expect(isTurnUsageRowArray([null])).toBe(false);
    expect(isTurnUsageRowArray(['not-a-row'])).toBe(false);
  });

  it('rejects a row missing a required numeric field', () => {
    const malformed = { ...row(), tokensIn: undefined };
    expect(isTurnUsageRowArray([malformed])).toBe(false);
  });

  it('rejects a row whose cost is not an object', () => {
    const malformed = { ...row(), cost: 0.15 };
    expect(isTurnUsageRowArray([malformed])).toBe(false);
  });

  it('rejects a row with a non-finite numeric field', () => {
    const malformed = { ...row(), tokensIn: Number.NaN };
    expect(isTurnUsageRowArray([malformed])).toBe(false);
  });
});
