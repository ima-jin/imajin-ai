/**
 * Pure grouping/formatting helpers for the /jin live usage feed panel
 * (#1864). Split out from the component so grouping, delta-tone, and
 * truncation logic is unit-testable without rendering React or touching the
 * DOM — mirrors the split `GET /auth/api/attestations/usage` (#1863) itself
 * already uses between its route handler and `usage-rollup.ts`.
 */

/** One row of `GET /auth/api/attestations/usage`'s response (#1863). */
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

export interface SessionGroup {
  /** Stable React key — the session key, or a synthetic one for session-less turns. */
  key: string;
  sessionKey: string | null;
  /** Turns in this session, newest first (the same order the endpoint returns). */
  rows: TurnUsageRow[];
  /** Running totals as of the group's newest turn (server-computed cumulative). */
  totals: { tokensIn: number; tokensOut: number; costTotal: number };
}

/**
 * Group newest-first turn rows by session, preserving newest-session-first
 * ordering — a session's group appears wherever its most recent turn does,
 * since the input is already newest first.
 *
 * Turns with no `sessionKey` are each treated as their own singleton
 * session, mirroring `computeTurnUsageRollups`'s own behavior
 * (usage-rollup.ts) for the same case, rather than being merged together
 * under one shared "no session" bucket.
 */
export function groupBySession(rows: readonly TurnUsageRow[]): SessionGroup[] {
  const groups: SessionGroup[] = [];
  const byKey = new Map<string, SessionGroup>();

  for (const row of rows) {
    const groupKey = row.sessionKey ?? `__no_session__:${row.id}`;
    const existing = byKey.get(groupKey);
    if (existing) {
      existing.rows.push(row);
      continue;
    }
    // Rows arrive newest-first, so the first row seen for a session already
    // carries its newest (largest) cumulative totals.
    const group: SessionGroup = {
      key: groupKey,
      sessionKey: row.sessionKey,
      rows: [row],
      totals: { tokensIn: row.sessionTokensIn, tokensOut: row.sessionTokensOut, costTotal: row.sessionCostTotal },
    };
    byKey.set(groupKey, group);
    groups.push(group);
  }

  return groups;
}

export type DeltaTone = 'higher' | 'lower' | 'first';

/**
 * Classify a turn's token delta for the feed's color coding: lower (green)
 * when usage dropped vs the previous turn in the session, higher (red) when
 * it rose, first (gray) for a session's first turn. The endpoint always
 * computes `tokenDelta: 0` for a genuine first turn from the full session
 * history (see usage-rollup.ts), so 0 doubles as that signal here too.
 */
export function deltaTone(tokenDelta: number): DeltaTone {
  if (tokenDelta > 0) return 'higher';
  if (tokenDelta < 0) return 'lower';
  return 'first';
}

/** "did:imajin:ADEK…Can54k" — head + tail chars, full value available via `title`. */
export function truncateId(value: string, headLength = 10, tailLength = 6): string {
  if (value.length <= headLength + tailLength + 1) return value;
  return `${value.slice(0, headLength)}…${value.slice(-tailLength)}`;
}

/** "$0.2400" — usage costs are frequently sub-cent, so keep 4 decimals rather than 2. */
export function formatCost(usd: number): string {
  return `$${usd.toFixed(4)}`;
}
