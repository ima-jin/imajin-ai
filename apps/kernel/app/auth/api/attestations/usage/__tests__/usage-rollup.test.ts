import { describe, it, expect } from 'vitest';
import { computeTurnUsageRollups, type RawTurnUsageRow } from '../usage-rollup';

function turn(overrides: {
  id: string;
  issuedAt: string;
  session?: string;
  tokensIn?: number;
  tokensOut?: number;
  total?: number;
  costInput?: number;
  costOutput?: number;
  costTotal?: number;
  model?: string;
  channel?: string;
  durationMs?: number;
}): RawTurnUsageRow {
  return {
    id: overrides.id,
    issuedAt: new Date(overrides.issuedAt),
    payload: {
      session: overrides.session,
      model: overrides.model ?? 'anthropic/claude-opus-4-6',
      tokens: {
        input: overrides.tokensIn ?? 0,
        output: overrides.tokensOut ?? 0,
        total: overrides.total,
      },
      cost: {
        input: overrides.costInput ?? 0,
        output: overrides.costOutput ?? 0,
        total: overrides.costTotal ?? 0,
      },
      channel: overrides.channel ?? 'telegram',
      durationMs: overrides.durationMs,
    },
  };
}

describe('computeTurnUsageRollups', () => {
  it('gives the first turn in a session a tokenDelta of 0 and session totals equal to its own values', () => {
    const [row] = computeTurnUsageRollups([
      turn({ id: 'att_1', issuedAt: '2026-08-18T22:00:00.000Z', session: 's1', tokensIn: 12000, tokensOut: 800, total: 17800, costTotal: 0.24 }),
    ]);

    expect(row.tokenDelta).toBe(0);
    expect(row.sessionTokensIn).toBe(12000);
    expect(row.sessionTokensOut).toBe(800);
    expect(row.sessionCostTotal).toBe(0.24);
  });

  it('computes tokenDelta as totalTokens(this) - totalTokens(previous in same session)', () => {
    const rows = computeTurnUsageRollups([
      turn({ id: 'att_1', issuedAt: '2026-08-18T22:00:00.000Z', session: 's1', total: 10000 }),
      turn({ id: 'att_2', issuedAt: '2026-08-18T22:05:00.000Z', session: 's1', total: 13500 }),
    ]);

    expect(rows[0].tokenDelta).toBe(0);
    expect(rows[1].tokenDelta).toBe(3500);
  });

  it('accumulates sessionTokensIn/Out/CostTotal cumulatively up to and including each turn', () => {
    const rows = computeTurnUsageRollups([
      turn({ id: 'att_1', issuedAt: '2026-08-18T22:00:00.000Z', session: 's1', tokensIn: 1000, tokensOut: 100, costTotal: 1 }),
      turn({ id: 'att_2', issuedAt: '2026-08-18T22:05:00.000Z', session: 's1', tokensIn: 2000, tokensOut: 200, costTotal: 2 }),
      turn({ id: 'att_3', issuedAt: '2026-08-18T22:10:00.000Z', session: 's1', tokensIn: 3000, tokensOut: 300, costTotal: 3 }),
    ]);

    expect(rows.map((r) => r.sessionTokensIn)).toEqual([1000, 3000, 6000]);
    expect(rows.map((r) => r.sessionTokensOut)).toEqual([100, 300, 600]);
    expect(rows.map((r) => r.sessionCostTotal)).toEqual([1, 3, 6]);
  });

  it('keeps independent rollups for different sessions interleaved in time', () => {
    const rows = computeTurnUsageRollups([
      turn({ id: 'att_1', issuedAt: '2026-08-18T22:00:00.000Z', session: 's1', tokensIn: 100, total: 100 }),
      turn({ id: 'att_2', issuedAt: '2026-08-18T22:01:00.000Z', session: 's2', tokensIn: 500, total: 500 }),
      turn({ id: 'att_3', issuedAt: '2026-08-18T22:02:00.000Z', session: 's1', tokensIn: 150, total: 300 }),
    ]);

    // att_3 is the second turn in s1 — delta compares against att_1 (100), not att_2.
    expect(rows[2].tokenDelta).toBe(200);
    expect(rows[2].sessionTokensIn).toBe(250);
    // s2's single turn is unaffected by s1's activity.
    expect(rows[1].tokenDelta).toBe(0);
    expect(rows[1].sessionTokensIn).toBe(500);
  });

  it('treats rows with no session claim as independent singleton sessions', () => {
    const rows = computeTurnUsageRollups([
      turn({ id: 'att_1', issuedAt: '2026-08-18T22:00:00.000Z', total: 100 }),
      turn({ id: 'att_2', issuedAt: '2026-08-18T22:01:00.000Z', total: 999 }),
    ]);

    expect(rows[0].sessionKey).toBeNull();
    expect(rows[1].sessionKey).toBeNull();
    expect(rows[0].tokenDelta).toBe(0);
    expect(rows[1].tokenDelta).toBe(0); // not compared against att_1 since neither has a real session key
  });

  it('falls back to tokens.input + tokens.output when tokens.total is absent', () => {
    const [row] = computeTurnUsageRollups([
      turn({ id: 'att_1', issuedAt: '2026-08-18T22:00:00.000Z', session: 's1', tokensIn: 400, tokensOut: 100 }),
    ]);
    const [, second] = computeTurnUsageRollups([
      turn({ id: 'att_1', issuedAt: '2026-08-18T22:00:00.000Z', session: 's1', tokensIn: 400, tokensOut: 100 }),
      turn({ id: 'att_2', issuedAt: '2026-08-18T22:01:00.000Z', session: 's1', tokensIn: 600, tokensOut: 100 }),
    ]);

    expect(row.tokenDelta).toBe(0);
    expect(second.tokenDelta).toBe(200); // (600+100) - (400+100)
  });

  it('passes through model, channel, cost breakdown, and durationMs, defaulting durationMs to null', () => {
    const [withDuration] = computeTurnUsageRollups([
      turn({ id: 'att_1', issuedAt: '2026-08-18T22:00:00.000Z', session: 's1', model: 'anthropic/claude-opus-4-6', channel: 'telegram', costInput: 0.18, costOutput: 0.06, costTotal: 0.24, durationMs: 8500 }),
    ]);
    const [withoutDuration] = computeTurnUsageRollups([
      turn({ id: 'att_2', issuedAt: '2026-08-18T22:00:00.000Z', session: 's1' }),
    ]);

    expect(withDuration.model).toBe('anthropic/claude-opus-4-6');
    expect(withDuration.channel).toBe('telegram');
    expect(withDuration.cost).toEqual({ input: 0.18, output: 0.06, total: 0.24 });
    expect(withDuration.durationMs).toBe(8500);
    expect(withoutDuration.durationMs).toBeNull();
  });

  it('preserves ascending input order in the output (caller reverses for newest-first)', () => {
    const rows = computeTurnUsageRollups([
      turn({ id: 'att_1', issuedAt: '2026-08-18T22:00:00.000Z', session: 's1' }),
      turn({ id: 'att_2', issuedAt: '2026-08-18T22:05:00.000Z', session: 's1' }),
    ]);

    expect(rows.map((r) => r.id)).toEqual(['att_1', 'att_2']);
  });
});
