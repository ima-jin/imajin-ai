/**
 * Pure aggregation for GET /auth/api/attestations/usage (#1863).
 *
 * Split from the route handler (mirrors the split already used by
 * `src/lib/kernel/telemetry-usage.ts`: pure aggregation math kept separate
 * from the DB read) so the delta/rollup computation is unit-testable
 * without a database.
 *
 * Deltas and session rollups are computed in a single ascending-time pass
 * per the issue spec: `tokenDelta` = totalTokens(thisTurn) -
 * totalTokens(previousTurnInSameSession) (0 for a session's first turn),
 * and `sessionTokensIn/Out/CostTotal` are running cumulative totals for the
 * session up to and including this turn.
 */

/** Shape of the `agent.turn.usage` claim carried in `attestations.payload` (#1842/#1843). */
export interface TurnUsageClaim {
  session?: unknown;
  runId?: unknown;
  model?: unknown;
  tokens?: {
    input?: unknown;
    output?: unknown;
    total?: unknown;
  } | null;
  cost?: {
    input?: unknown;
    output?: unknown;
    total?: unknown;
  } | null;
  channel?: unknown;
  durationMs?: unknown;
}

/** A raw attestation row read from the DB, ordered ascending by `issuedAt`. */
export interface RawTurnUsageRow {
  id: string;
  issuedAt: Date;
  payload: unknown;
}

/** One computed row of the `GET /auth/api/attestations/usage` response. */
export interface TurnUsageRow {
  id: string;
  issuedAt: string;
  sessionKey: string | null;
  model: string | null;
  tokensIn: number;
  tokensOut: number;
  tokenDelta: number;
  sessionTokensIn: number;
  sessionTokensOut: number;
  cost: { input: number; output: number; total: number };
  sessionCostTotal: number;
  channel: string | null;
  durationMs: number | null;
}

function numberOr0(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** Round a cost total to 6 decimal places to avoid IEEE754 sum drift across many turns. */
function roundCost(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

interface SessionAccumulator {
  totalTokens: number;
  sessionTokensIn: number;
  sessionTokensOut: number;
  sessionCostTotal: number;
}

/**
 * Compute per-turn deltas and per-session rollups for a set of
 * `agent.turn.usage` attestation rows.
 *
 * `rowsAscending` MUST be sorted oldest-first (ascending `issuedAt`) so that
 * "previous turn in same session" and "cumulative up to and including this
 * turn" are well-defined. The returned array preserves that same ascending
 * order — callers that want newest-first (per the issue's response
 * ordering requirement) should reverse the result.
 *
 * Rows without a `session` claim field are each treated as their own
 * singleton session (so `tokenDelta` is 0 and the session totals equal the
 * row's own values) rather than being merged together under one bucket.
 */
export function computeTurnUsageRollups(rowsAscending: readonly RawTurnUsageRow[]): TurnUsageRow[] {
  const sessionState = new Map<string, SessionAccumulator>();
  const results: TurnUsageRow[] = [];

  for (const row of rowsAscending) {
    const claim = (row.payload ?? {}) as TurnUsageClaim;
    const sessionKey = stringOrNull(claim.session);
    const groupKey = sessionKey ?? `__no_session__:${row.id}`;

    const tokensIn = numberOr0(claim.tokens?.input);
    const tokensOut = numberOr0(claim.tokens?.output);
    const claimedTotal = numberOr0(claim.tokens?.total);
    const totalTokens = claimedTotal > 0 ? claimedTotal : tokensIn + tokensOut;

    const costInput = numberOr0(claim.cost?.input);
    const costOutput = numberOr0(claim.cost?.output);
    const costTotal = numberOr0(claim.cost?.total);

    const prev = sessionState.get(groupKey);
    const tokenDelta = prev ? totalTokens - prev.totalTokens : 0;
    const sessionTokensIn = numberOr0(prev?.sessionTokensIn) + tokensIn;
    const sessionTokensOut = numberOr0(prev?.sessionTokensOut) + tokensOut;
    const sessionCostTotal = roundCost(numberOr0(prev?.sessionCostTotal) + costTotal);

    sessionState.set(groupKey, {
      totalTokens,
      sessionTokensIn,
      sessionTokensOut,
      sessionCostTotal,
    });

    results.push({
      id: row.id,
      issuedAt: row.issuedAt.toISOString(),
      sessionKey,
      model: stringOrNull(claim.model),
      tokensIn,
      tokensOut,
      tokenDelta,
      sessionTokensIn,
      sessionTokensOut,
      cost: { input: costInput, output: costOutput, total: costTotal },
      sessionCostTotal,
      channel: stringOrNull(claim.channel),
      durationMs: typeof claim.durationMs === 'number' && Number.isFinite(claim.durationMs) ? claim.durationMs : null,
    });
  }

  return results;
}
