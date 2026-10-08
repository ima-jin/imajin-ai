'use client';

/**
 * Spend lane on `/jin` (#2725, epic #2288) — what the agents cost, readable on
 * a phone: today's cost per provider, each provider's current-period spend
 * next to its cap (near/over flagged), the 7-day trend, and — labelled
 * INTERIM — the cost of recent Warp runs and the cost per closed issue this
 * month.
 *
 * Data sources (all read-only, no new tables):
 *   - `GET /jin/api/spend`       → `usage.incurred` (USD) + connector spend caps
 *   - `GET /jin/api/spend/runs`  → Warp run `requestUsage` ("Warp-reported",
 *     Warp's own units, never converted) + `usage.incurred` joined by
 *     `session_id` ("metered", USD) + GitHub issue state. The derivation is
 *     the stopgap in `src/lib/jin/spend-interim-join.ts`, replaced by the loop
 *     registry (#2290).
 *
 * Same operator gate as the other /jin lanes: renders nothing (not even a
 * header) until the server says `isOperator: true`, so a non-operator never
 * sees panel chrome. Layout is a single column with no fixed widths so it fits
 * a ~390px viewport without horizontal scroll (`min-w-0` + `truncate` +
 * `flex-wrap` on every row).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { CapStatus, ProviderSpend, SpendLane, TrendDay } from '@/src/lib/jin/spend-lane';
import type { InterimRunCost, InterimSpend } from '@/src/lib/jin/spend-interim-join';

const POLL_INTERVAL_MS = 30_000;

// `bar` strings are literal (not built) so Tailwind's content scan emits them; they colour a native <progress>.
const STATUS_STYLES: Record<CapStatus, { chip: string; bar: string; label: string }> = {
  ok: { chip: 'bg-green-900/50 text-green-300', bar: '[&::-webkit-progress-value]:bg-green-500 [&::-moz-progress-bar]:bg-green-500', label: 'ok' },
  near: { chip: 'bg-yellow-900/60 text-yellow-300', bar: '[&::-webkit-progress-value]:bg-yellow-500 [&::-moz-progress-bar]:bg-yellow-500', label: 'near cap' },
  over: { chip: 'bg-red-900/50 text-red-400', bar: '[&::-webkit-progress-value]:bg-red-500 [&::-moz-progress-bar]:bg-red-500', label: 'at cap' },
  uncapped: { chip: 'bg-gray-800 text-gray-500', bar: '[&::-webkit-progress-value]:bg-gray-600 [&::-moz-progress-bar]:bg-gray-600', label: 'no cap' },
  unknown: { chip: 'bg-gray-800 text-gray-400', bar: '[&::-webkit-progress-value]:bg-gray-600 [&::-moz-progress-bar]:bg-gray-600', label: 'unmeasured' },
};

// ── Formatting ────────────────────────────────────────────────────────────────

export function formatUsd(usd: number): string {
  return `$${usd.toFixed(usd >= 1 ? 2 : 4)}`;
}

/** Warp's own units — shown as reported, never converted to USD. */
export function formatWarpUnits(units: number): string {
  return `${units.toFixed(2)} units`;
}

function weekday(date: string): string {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toLocaleDateString('en-US', { weekday: 'narrow', timeZone: 'UTC' });
}

// ── Provider block ────────────────────────────────────────────────────────────

function CapBar({ provider }: Readonly<{ provider: ProviderSpend }>) {
  if (!provider.cap) return null;
  const style = STATUS_STYLES[provider.status];
  const pct = Math.min(100, Math.round((provider.ratio ?? 0) * 100));
  return (
    <div className="mt-1.5">
      <progress
        className={`block h-1.5 w-full appearance-none overflow-hidden rounded bg-gray-800 [&::-webkit-progress-bar]:bg-gray-800 ${style.bar}`}
        aria-label={`${provider.name} spend against cap`}
        max={100}
        value={pct}
      />
      <p className="mt-1 text-[11px] text-gray-500 break-words">
        {provider.periodSpentUsd === null ? 'spend unmeasured' : formatUsd(provider.periodSpentUsd)} of{' '}
        {formatUsd(provider.cap.amountUsd)} {provider.cap.period} cap
      </p>
    </div>
  );
}

function ProviderRow({ provider }: Readonly<{ provider: ProviderSpend }>) {
  const style = STATUS_STYLES[provider.status];
  return (
    <li className="rounded-lg border border-gray-800 px-3 py-2" data-testid="spend-provider" data-status={provider.status}>
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 truncate text-sm text-gray-100" title={provider.provider}>{provider.name}</span>
        <span className="flex items-center gap-2 shrink-0">
          <span className="text-sm font-mono text-gray-100" data-testid="spend-provider-today">{formatUsd(provider.todayUsd)}</span>
          <span className={`px-1.5 py-0.5 rounded text-[10px] ${style.chip}`}>{style.label}</span>
        </span>
      </div>
      <CapBar provider={provider} />
    </li>
  );
}

function Trend({ days }: Readonly<{ days: TrendDay[] }>) {
  const max = Math.max(...days.map((d) => d.totalUsd), 0);
  return (
    <div role="img" aria-label="7-day spend trend" data-testid="spend-trend">
      <div className="flex items-end gap-1 h-10">
        {days.map((day) => {
          const heightPct = max > 0 ? Math.max(4, Math.round((day.totalUsd / max) * 100)) : 4;
          return (
            <div
              key={day.date}
              className="flex-1 min-w-0 rounded-sm bg-amber-500/70"
              style={{ height: `${heightPct}%` }}
              title={`${day.date}: ${formatUsd(day.totalUsd)}`}
              data-testid="spend-trend-bar"
            />
          );
        })}
      </div>
      <div className="flex gap-1 mt-0.5">
        {days.map((day) => (
          <span key={day.date} className="flex-1 min-w-0 text-center text-[9px] text-gray-600">{weekday(day.date)}</span>
        ))}
      </div>
    </div>
  );
}

function ProviderBlock({ spend }: Readonly<{ spend: SpendLane }>) {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <p className="text-sm text-gray-400">
          Today <span className="font-mono text-gray-100" data-testid="spend-today-total">{formatUsd(spend.todayUsd)}</span>
        </p>
        <p className="text-xs text-gray-500">
          7 days <span className="font-mono text-gray-300" data-testid="spend-week-total">{formatUsd(spend.weekUsd)}</span>
        </p>
      </div>
      <Trend days={spend.trend} />
      {spend.providers.length === 0 ? (
        <p className="text-sm text-gray-500">No provider spend or caps in the last 7 days.</p>
      ) : (
        <ul className="space-y-2">
          {spend.providers.map((p) => <ProviderRow key={p.provider} provider={p} />)}
        </ul>
      )}
    </div>
  );
}

// ── Interim block ─────────────────────────────────────────────────────────────

function InterimBadge({ label }: Readonly<{ label: string }>) {
  return (
    <span className="inline-block max-w-full px-1.5 py-0.5 rounded text-[10px] bg-indigo-900/40 text-indigo-300 break-words" data-testid="spend-interim-label">
      {label}
    </span>
  );
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function noClosedIssueReason(interim: InterimSpend): string {
  const why = interim.githubAvailable ? 'no linked issue is closed yet' : 'issue state unknown — GitHub read not available';
  const linked = interim.closedIssueCost.unknownCount;
  return linked > 0 ? `${why}; ${plural(linked, 'linked issue')} unresolved` : why;
}

function ClosedIssueSummary({ interim }: Readonly<{ interim: InterimSpend }>) {
  const c = interim.closedIssueCost;
  if (c.closedCount === 0) {
    return (
      <p className="text-sm text-gray-400" data-testid="spend-closed-issue-cost">
        Cost per closed issue: <span className="text-gray-500">n/a ({noClosedIssueReason(interim)})</span>
      </p>
    );
  }
  const parts = [
    c.meteredUsdPerIssue === null ? null : `${formatUsd(c.meteredUsdPerIssue)} metered`,
    c.warpPerIssue === null ? null : `${formatWarpUnits(c.warpPerIssue)} Warp-reported`,
  ].filter((p): p is string => p !== null);
  return (
    <p className="text-sm text-gray-300 break-words" data-testid="spend-closed-issue-cost">
      Cost per closed issue: <span className="font-mono">{parts.join(' · ') || 'unattributed'}</span>
      <span className="text-gray-500"> · {c.closedCount} closed this month</span>
    </p>
  );
}

function RunCostLines({ run }: Readonly<{ run: InterimRunCost }>) {
  return (
    <div className="mt-1.5 space-y-0.5 text-[11px] text-gray-400" data-testid="spend-run-detail">
      {run.warp && (
        <div className="break-words">
          Warp-reported: inference {run.warp.inference ?? '—'} · compute {run.warp.compute ?? '—'} · platform {run.warp.platform ?? '—'} (units)
        </div>
      )}
      {run.metered && (
        <div>
          Metered: {run.metered.usd === null ? 'cost unknown' : formatUsd(run.metered.usd)} over {plural(run.metered.turns, 'turn')}
        </div>
      )}
      {run.attribution === 'unattributed' && <div>No cost resolved for this run.</div>}
      {run.linkage.branch && <div className="font-mono break-all">{run.linkage.branch}</div>}
      {run.linkage.prUrl && (
        <div className="break-all">
          <a href={run.linkage.prUrl} target="_blank" rel="noreferrer" className="text-indigo-400 hover:text-indigo-300">PR #{run.linkage.prNumber ?? '?'}</a>
        </div>
      )}
      {run.linkage.issue && <div>issue #{run.linkage.issue.number} (via {run.linkage.issueVia})</div>}
    </div>
  );
}

function runHeadline(run: InterimRunCost): string {
  const meteredUsd = run.metered?.usd ?? null;
  const warpTotal = run.warp?.total ?? null;
  if (run.attribution === 'metered' && meteredUsd !== null) return `${formatUsd(meteredUsd)} metered`;
  if (run.attribution === 'warp-reported' && warpTotal !== null) return `${formatWarpUnits(warpTotal)} Warp`;
  return 'unattributed';
}

function RunRow({ run }: Readonly<{ run: InterimRunCost }>) {
  const [open, setOpen] = useState(false);
  return (
    <li className="rounded-lg border border-gray-800" data-testid="spend-run">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between gap-2 px-3 py-2 text-left"
      >
        <span className="min-w-0 truncate text-xs text-gray-300" title={run.runId}>{run.title ?? run.runId}</span>
        <span className="shrink-0 text-xs font-mono text-gray-200" data-testid="spend-run-cost">{runHeadline(run)}</span>
      </button>
      {open && <div className="px-3 pb-2"><RunCostLines run={run} /></div>}
    </li>
  );
}

function InterimBlock({ interim }: Readonly<{ interim: InterimSpend }>) {
  return (
    <div className="mt-5 space-y-2" data-testid="spend-interim">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold text-gray-200">Runs &amp; issues · this month</h3>
        <InterimBadge label={interim.label} />
      </div>
      {interim.runsAvailable ? (
        <>
          <ClosedIssueSummary interim={interim} />
          {interim.runs.length === 0 ? (
            <p className="text-sm text-gray-500">No Warp runs this month.</p>
          ) : (
            <ul className="space-y-2">{interim.runs.map((r) => <RunRow key={r.runId} run={r} />)}</ul>
          )}
          {interim.runsTruncated && <p className="text-[11px] text-gray-600">More runs exist than were read; figures cover the most recent page.</p>}
        </>
      ) : (
        <p className="text-sm text-gray-500" data-testid="spend-runs-unavailable">Warp runs unavailable — connect Warp to see per-run cost.</p>
      )}
    </div>
  );
}

// ── Panel ─────────────────────────────────────────────────────────────────────

function isAbortError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'AbortError';
}

export function SpendPanel() {
  const [isOperator, setIsOperator] = useState(false);
  const [spend, setSpend] = useState<SpendLane | null>(null);
  const [interim, setInterim] = useState<InterimSpend | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const loadSpend = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const res = await fetch('/jin/api/spend', { credentials: 'include', signal: controller.signal });
      if (controller.signal.aborted) return;
      if (!res.ok) {
        setError(`Failed to load spend (${res.status})`);
        return;
      }
      const data = (await res.json()) as { isOperator: boolean; spend: SpendLane | null };
      if (controller.signal.aborted) return;
      setIsOperator(data.isOperator);
      setSpend(data.spend);
      setError(null);
    } catch (err) {
      if (!controller.signal.aborted && !isAbortError(err)) setError('Network error loading spend');
    }
  }, []);

  const loadInterim = useCallback(async () => {
    try {
      const res = await fetch('/jin/api/spend/runs', { credentials: 'include' });
      if (!res.ok) return;
      const data = (await res.json()) as { isOperator: boolean; interim: InterimSpend | null };
      setInterim(data.isOperator ? data.interim : null);
    } catch {
      // Interim block simply stays absent on a transient failure.
    }
  }, []);

  useEffect(() => {
    void loadSpend();
    void loadInterim();
    const timer = setInterval(() => void loadSpend(), POLL_INTERVAL_MS);
    return () => {
      clearInterval(timer);
      abortRef.current?.abort();
    };
  }, [loadSpend, loadInterim]);

  // Operator gate: nothing — not even a header — for anyone else.
  if (!isOperator) return null;

  return (
    <section className="mt-8" data-testid="spend-lane">
      <div className="flex items-center justify-between gap-2 mb-3">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-gray-100">Spend</h2>
          <p className="text-xs text-gray-500">Provider cost vs caps · USD from usage.incurred</p>
        </div>
        <button
          type="button"
          onClick={() => { void loadSpend(); void loadInterim(); }}
          className="shrink-0 text-xs text-gray-500 hover:text-gray-300 transition-colors"
        >
          ↺ refresh
        </button>
      </div>

      {error && <div className="mb-3 px-3 py-2 rounded text-xs font-medium bg-red-900/40 text-red-300">{error}</div>}
      {spend && <ProviderBlock spend={spend} />}
      {interim && <InterimBlock interim={interim} />}
    </section>
  );
}
