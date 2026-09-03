/**
 * Pure grouping/formatting helpers for the /jin live usage feed panel
 * (#1864). Split out from the component so grouping, delta-tone, and
 * truncation logic is unit-testable without rendering React or touching the
 * DOM — mirrors the split `GET /auth/api/attestations/usage` (#1863) itself
 * already uses between its route handler and `usage-rollup.ts`.
 */
import type { TurnUsageRow } from '@/app/auth/api/attestations/usage/usage-rollup';

// Re-exported rather than re-declared: the endpoint (#1863) owns this shape,
// so this is the single source of truth every consumer (this panel, its
// tests) imports rather than a hand-copied duplicate that can drift.
export type { TurnUsageRow };

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

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isStringOrNull(value: unknown): value is string | null {
  return typeof value === 'string' || value === null;
}

/**
 * Runtime shape guard for one `GET /auth/api/attestations/usage` row.
 * `as TurnUsageRow[]` on a raw fetch response is a cast, not a check — this
 * gives the panel a real validation step so an endpoint schema drift (#1863)
 * surfaces as a handled error instead of silently rendering `undefined`s.
 */
function isTurnUsageRow(value: unknown): value is TurnUsageRow {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Record<string, unknown>;
  const cost = row.cost as Record<string, unknown> | null | undefined;
  return (
    typeof row.id === 'string' &&
    typeof row.issuedAt === 'string' &&
    isStringOrNull(row.sessionKey) &&
    isStringOrNull(row.model) &&
    isNumber(row.tokensIn) &&
    isNumber(row.tokensOut) &&
    isNumber(row.tokenDelta) &&
    isNumber(row.sessionTokensIn) &&
    isNumber(row.sessionTokensOut) &&
    isNumber(row.sessionCostTotal) &&
    typeof cost === 'object' && cost !== null &&
    isNumber(cost.input) && isNumber(cost.output) && isNumber(cost.total) &&
    isStringOrNull(row.channel) &&
    (isNumber(row.durationMs) || row.durationMs === null)
  );
}

/** Runtime shape guard for the endpoint's full response array. */
export function isTurnUsageRowArray(value: unknown): value is TurnUsageRow[] {
  return Array.isArray(value) && value.every(isTurnUsageRow);
}
