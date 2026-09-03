'use client';

/**
 * Live per-turn agent usage feed panel for the `/jin` kernel dashboard
 * (#1864). Sits alongside the confirm-rail panel (#1429) this file mirrors
 * for its data-fetching (poll + silent-refresh) and styling (dark table,
 * status-colored chips) conventions.
 *
 * Data source: `GET /auth/api/attestations/usage` (#1863) — the
 * purpose-built turn-usage query endpoint with server-computed per-turn
 * token deltas and session rollups. The newer `usage.incurred` stream
 * (#1956/#1958, `source: 'harness:nanoclaw'`, packages/nanoclaw-imajin-channel)
 * was evaluated as an alternative source but is not a fit today: it has no
 * GET query endpoint exposing individual rows (only period rollups via
 * `GET /usage/api/rollups`), and its schema carries no per-turn delta or
 * session-cumulative fields — every consumer would have to recompute both
 * client-side, which is exactly what #1863 exists to avoid. Worth
 * revisiting if `usage.incurred` grows an equivalent per-row query surface.
 */
import { useCallback, useEffect, useRef, useState, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { formatDistanceToNow } from 'date-fns';
import {
  groupBySession,
  deltaTone,
  truncateId,
  formatCost,
  type TurnUsageRow,
  type SessionGroup,
  type DeltaTone,
} from './usage-feed-grouping';

// Jin's prod DID (#1864's default subject) — overridable via
// NEXT_PUBLIC_JIN_DID or a `?subject_did=` query param so the panel works
// for any principal the endpoint authorizes (it is anonymous-callable —
// see attestations/usage/route.ts — so no session/auth constraint applies).
const DEFAULT_JIN_DID = 'did:imajin:ADEKFWc2pbTKzfgzA3q6yrc1rEPNeMEP71mkBbCan54k';
const FEED_LIMIT = 50;
// Live refresh is a 10s poll for v1, per the issue's explicit scope — an
// SSE/WebSocket push from the attestation write path would remove the
// latency/poll-cost tradeoff entirely but is out of scope for #1864.
const POLL_INTERVAL_MS = 10_000;

const DELTA_STYLES: Record<DeltaTone, string> = {
  higher: 'text-red-400',
  lower: 'text-green-400',
  first: 'text-gray-500',
};

function deltaLabel(tone: DeltaTone, tokenDelta: number): string {
  if (tone === 'first') return 'first turn';
  const sign = tone === 'higher' ? '+' : '';
  return `${sign}${tokenDelta.toLocaleString()}`;
}

function relativeTime(issuedAt: string): string {
  const date = new Date(issuedAt);
  return Number.isNaN(date.getTime()) ? '—' : formatDistanceToNow(date, { addSuffix: true });
}

function ModelBadge({ model }: Readonly<{ model: string | null }>) {
  return (
    <span className="px-1.5 py-0.5 rounded text-xs font-mono bg-indigo-900/40 text-indigo-300 whitespace-nowrap">
      {model ?? 'unknown'}
    </span>
  );
}

function TurnRow({ row }: Readonly<{ row: TurnUsageRow }>) {
  const tone = deltaTone(row.tokenDelta);

  return (
    <tr className="border-b border-gray-900 hover:bg-gray-900/40 transition-colors">
      <td className="px-4 py-2 text-xs text-gray-500 whitespace-nowrap">{relativeTime(row.issuedAt)}</td>
      <td className="px-4 py-2"><ModelBadge model={row.model} /></td>
      <td className="px-4 py-2 text-xs text-gray-300 text-right whitespace-nowrap">{row.tokensIn.toLocaleString()}</td>
      <td className="px-4 py-2 text-xs text-gray-300 text-right whitespace-nowrap">{row.tokensOut.toLocaleString()}</td>
      <td className={`px-4 py-2 text-xs text-right whitespace-nowrap ${DELTA_STYLES[tone]}`}>
        {deltaLabel(tone, row.tokenDelta)}
      </td>
      <td className="px-4 py-2 text-xs text-gray-300 text-right whitespace-nowrap">{formatCost(row.cost.total)}</td>
    </tr>
  );
}

function SessionSection({ group }: Readonly<{ group: SessionGroup }>) {
  const [expanded, setExpanded] = useState(true);
  const firstRow = group.rows[0];
  const label = group.sessionKey ?? `no session · ${firstRow.id}`;
  const fullLabel = group.sessionKey ?? firstRow.id;

  return (
    <div className="rounded-lg border border-gray-800 overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center justify-between gap-3 px-4 py-2 bg-gray-900/60 hover:bg-gray-900 transition-colors text-left"
      >
        <span className="flex items-center gap-2 min-w-0">
          <span className="text-gray-500 text-xs">{expanded ? '▾' : '▸'}</span>
          <span className="font-mono text-xs text-gray-300 truncate" title={fullLabel}>
            {truncateId(label)}
          </span>
          <span className="text-xs text-gray-600 whitespace-nowrap">
            · {group.rows.length} turn{group.rows.length === 1 ? '' : 's'}
          </span>
        </span>
        <span className="flex items-center gap-3 text-xs text-gray-500 whitespace-nowrap">
          <span>{group.totals.tokensIn.toLocaleString()} in</span>
          <span>{group.totals.tokensOut.toLocaleString()} out</span>
          <span className="text-gray-300">{formatCost(group.totals.costTotal)}</span>
        </span>
      </button>
      {expanded && (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-[10px] uppercase tracking-wide text-gray-600 border-b border-gray-900">
              <th className="px-4 py-1.5 text-left font-medium">Time</th>
              <th className="px-4 py-1.5 text-left font-medium">Model</th>
              <th className="px-4 py-1.5 text-right font-medium">Tokens in</th>
              <th className="px-4 py-1.5 text-right font-medium">Tokens out</th>
              <th className="px-4 py-1.5 text-right font-medium">Δ vs prev</th>
              <th className="px-4 py-1.5 text-right font-medium">Cost</th>
            </tr>
          </thead>
          <tbody>
            {group.rows.map((row) => <TurnRow key={row.id} row={row} />)}
          </tbody>
        </table>
      )}
    </div>
  );
}

// S3358: avoid nested ternary by extracting render logic (mirrors
// renderBody's role for the proposals table in page.tsx).
function renderFeedBody(loading: boolean, groups: SessionGroup[]) {
  if (loading) {
    return <p className="text-sm text-gray-500 py-8 text-center">Loading…</p>;
  }
  if (groups.length === 0) {
    return (
      <div className="text-center py-12 rounded-lg border border-gray-800">
        <p className="text-gray-500 text-sm">
          No turns recorded yet. Agent usage attestations start after the next gateway restart.
        </p>
      </div>
    );
  }
  return (
    <div className="space-y-3">
      {groups.map((group) => <SessionSection key={group.key} group={group} />)}
    </div>
  );
}

function resolveSubjectDid(searchParams: URLSearchParams): string {
  return searchParams.get('subject_did') || process.env.NEXT_PUBLIC_JIN_DID || DEFAULT_JIN_DID;
}

function UsageFeedPanelInner() {
  const searchParams = useSearchParams();
  const subjectDid = resolveSubjectDid(searchParams);

  const [rows, setRows] = useState<TurnUsageRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const res = await fetch(
        `/auth/api/attestations/usage?subject_did=${encodeURIComponent(subjectDid)}&limit=${FEED_LIMIT}`,
        { credentials: 'include' },
      );
      if (!res.ok) {
        setError(`Failed to load usage feed (${res.status})`);
        return;
      }
      const data = await res.json() as TurnUsageRow[];
      setRows(Array.isArray(data) ? data : []);
      setError(null);
    } catch {
      if (!silent) setError('Network error loading usage feed');
    } finally {
      if (!silent) setLoading(false);
    }
  }, [subjectDid]);

  useEffect(() => {
    load();
    pollRef.current = setInterval(() => load(true), POLL_INTERVAL_MS);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [load]);

  const groups = groupBySession(rows);

  return (
    <section className="mt-8">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h2 className="text-base font-semibold text-gray-100">Agent usage feed</h2>
          <p className="text-xs text-gray-500">Per-turn token usage, grouped by session · polls every 10s</p>
        </div>
        <button
          type="button"
          onClick={() => load()}
          className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
        >
          ↺ refresh
        </button>
      </div>

      {error && (
        <div className="mb-3 px-3 py-2 rounded text-xs font-medium bg-red-900/40 text-red-300">{error}</div>
      )}

      {renderFeedBody(loading, groups)}
    </section>
  );
}

export function UsageFeedPanel() {
  return (
    <Suspense fallback={<p className="text-sm text-gray-500 py-8 text-center">Loading…</p>}>
      <UsageFeedPanelInner />
    </Suspense>
  );
}
