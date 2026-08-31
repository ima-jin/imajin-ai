/**
 * Scheduled fallback for the Warp run watch (#1838).
 *
 * ## Why this exists
 * `dispatchAgentRun` fires `watchRun` fire-and-forget from
 * `apps/kernel/app/warp/api/dispatch/route.ts` immediately after the 201
 * response is sent. That is background work inside the *same* serverless
 * function invocation, which the platform is free to suspend once the
 * response has gone out — so a run whose watch dies mid-flight would
 * otherwise never report anything: no `warp.run.completed`/`warp.run.failed`,
 * and no `warp.run.blocked` nudge for a run stuck waiting on a human. This
 * sweep is the safety net: on a modest cron interval it re-checks any
 * dispatched run that has no terminal event yet and publishes the same
 * events the in-request watch would have.
 *
 * ## Webhook ingress was investigated first (#1838's own preference order)
 * Warp's run object carries `triggerUrl` (see `WarpAgentRun` in ./dispatch),
 * but that field documents what *triggered* the run — a Slack thread, a
 * Linear issue, a schedule — not a callback target Warp will POST a
 * completion to, and Warp's public Agent API has no run-completion webhook
 * registration endpoint. So the fallback this issue asks for (a scheduled
 * kernel-side watcher, polling only in-flight runs, with backoff on long
 * runs) is what this module implements.
 *
 * ## Consolidation, not duplication
 * Every read and publish here reuses the exact functions the in-request watch
 * uses — {@link getAgentRun}, {@link publishTerminalRunOutcome},
 * {@link publishBlockedRunOutcome} — so there is exactly one place that
 * decides what a run's state becomes on the bus. This module only supplies a
 * different *trigger* (a periodic tick instead of an in-process poll loop)
 * and the "which runs are still in flight" query, which the in-process watch
 * does not need because it already knows the one run it is watching.
 *
 * ## Finding in-flight runs without a new table
 * `dispatchAgentRun` publishes `warp.agent.dispatched`, which the `warp:dispatch`
 * grant scope entitles (packages/auth/src/grant-scopes.ts) — so
 * `packages/bus`'s event-subscription fan-out (#1884) already writes a durable
 * row to `kernel.event_subscription_log` for every dispatch, carrying the
 * `runId` (in `payload`) and the dispatching principal (`subject_did`). That
 * is "already stored kernel-side with the acting principal" from the issue:
 * this sweep reads it rather than introducing a second, parallel place that
 * tracks the same fact. A run counts as in-flight when it has a
 * `warp.agent.dispatched` row and no `warp.run.completed` / `warp.run.failed` /
 * `warp.run.timeout` row for the same `runId` yet.
 *
 * ## Backoff on long runs
 * `SWEEP_LOOKBACK_MS` bounds how far back the dispatched-but-not-terminal
 * query looks. A run dispatched longer ago than that is not re-checked by the
 * sweep even if it is still (somehow) lacking a terminal event — the
 * in-request watch's own 30-minute budget (`WATCH_TIMEOUT_MS`) is what
 * normally closes out a run this old, so one still showing up here past the
 * lookback is an anomaly worth a log line, not indefinite re-polling.
 */
import { getClient } from '@imajin/db';
import { createLogger } from '@imajin/logger';
import {
  getAgentRun,
  isTerminalRunState,
  publishBlockedRunOutcome,
  publishTerminalRunOutcome,
  WarpApiError,
} from './dispatch';

const log = createLogger('kernel');

/**
 * How far back the sweep looks for dispatched-but-not-terminal runs.
 *
 * Six hours comfortably covers the in-request watch's own 30-minute budget
 * plus room for a BLOCKED run to sit waiting on a human across a lunch break,
 * while still bounding the query and the per-tick read volume (see "Backoff
 * on long runs" above).
 */
export const SWEEP_LOOKBACK_MS = 6 * 60 * 60 * 1000;

/** One dispatched run with no terminal event yet. */
interface InFlightRun {
  runId: string;
  principalDid: string;
  dispatchedAt: Date;
}

/** Tally of what one sweep invocation did, returned for the cron route's response/log line. */
export interface SweepOutcome {
  /** In-flight candidates the sweep examined. */
  checked: number;
  /** Reached SUCCEEDED or CANCELLED this tick. */
  completed: number;
  /** Reached FAILED this tick. */
  failed: number;
  /** Newly observed BLOCKED and notified for the first time this tick. */
  blockedNotified: number;
  /** Still not terminal (including a run already known to be blocked). */
  stillInFlight: number;
  /** Reads or publishes that failed; logged individually, never fatal to the sweep. */
  errors: number;
}

function emptyOutcome(): SweepOutcome {
  return { checked: 0, completed: 0, failed: 0, blockedNotified: 0, stillInFlight: 0, errors: 0 };
}

/**
 * Dispatched runs with no terminal event yet, newest dispatch per run id.
 *
 * `DISTINCT` on the inner query collapses a run to one row even though
 * `warp.agent.dispatched` could in principle be logged more than once for the
 * same `runId` (it never is in practice, dispatch is one-shot, but the query
 * should not double-count if that ever changed). The anti-join against the
 * three terminal event types is what "in flight" means here.
 */
async function listInFlightDispatchedRuns(lookbackMs: number): Promise<InFlightRun[]> {
  const sql = getClient();
  const cutoff = new Date(Date.now() - lookbackMs);

  const rows = await sql`
    SELECT sub.run_id AS "runId", sub.principal_did AS "principalDid", sub.dispatched_at AS "dispatchedAt"
    FROM (
      SELECT DISTINCT
        payload->>'runId' AS run_id,
        subject_did AS principal_did,
        occurred_at AS dispatched_at
      FROM kernel.event_subscription_log
      WHERE event_type = 'warp.agent.dispatched'
        AND occurred_at > ${cutoff.toISOString()}
    ) sub
    WHERE sub.run_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM kernel.event_subscription_log terminal
        WHERE terminal.event_type IN ('warp.run.completed', 'warp.run.failed', 'warp.run.timeout')
          AND terminal.payload->>'runId' = sub.run_id
      )
  `;

  const candidates: InFlightRun[] = [];
  for (const row of rows as unknown as Array<{
    runId: unknown;
    principalDid: unknown;
    dispatchedAt: unknown;
  }>) {
    if (typeof row.runId !== 'string' || typeof row.principalDid !== 'string') continue;
    const dispatchedAt = row.dispatchedAt instanceof Date ? row.dispatchedAt : new Date(String(row.dispatchedAt));
    candidates.push({ runId: row.runId, principalDid: row.principalDid, dispatchedAt });
  }
  return candidates;
}

/**
 * Whether `warp.run.blocked` has already been published for `runId`.
 *
 * The sweep has no in-memory tracker the way the in-request watch does
 * (`ProgressTracker.blockedNotified`) — each invocation is a fresh,
 * stateless function call — so it asks the same durable log this module
 * already reads for candidates, which also durably logs `warp.run.blocked`
 * (entitled under `warp:dispatch`, packages/auth/src/grant-scopes.ts).
 */
async function hasPublishedBlockedNotice(runId: string): Promise<boolean> {
  const sql = getClient();
  const rows = await sql`
    SELECT 1
    FROM kernel.event_subscription_log
    WHERE event_type = 'warp.run.blocked'
      AND payload->>'runId' = ${runId}
    LIMIT 1
  `;
  return rows.length > 0;
}

/** Read `candidate` once and publish whatever the read reveals. Never throws. */
async function checkOneRun(candidate: InFlightRun, outcome: SweepOutcome): Promise<void> {
  const run = await getAgentRun(candidate.principalDid, candidate.runId);

  if (isTerminalRunState(run.state)) {
    await publishTerminalRunOutcome(candidate.principalDid, run, run.state);
    if (run.state === 'FAILED') outcome.failed += 1;
    else outcome.completed += 1;
    return;
  }

  if (run.state === 'BLOCKED') {
    if (await hasPublishedBlockedNotice(candidate.runId)) {
      outcome.stillInFlight += 1;
      return;
    }
    await publishBlockedRunOutcome(candidate.principalDid, run);
    outcome.blockedNotified += 1;
    return;
  }

  outcome.stillInFlight += 1;
}

/**
 * Sweep every in-flight dispatched run once, publishing whichever of
 * `warp.run.completed` / `warp.run.failed` / `warp.run.blocked` applies.
 *
 * Called from `GET /api/cron/warp-run-watch` on a modest schedule (see
 * vercel.json). Never throws — a candidate that fails to read or publish is
 * counted in `errors` and logged, and the sweep moves on to the rest; the
 * next tick tries it again.
 */
export async function sweepInFlightWarpRuns(
  options: { lookbackMs?: number } = {},
): Promise<SweepOutcome> {
  const lookbackMs = options.lookbackMs ?? SWEEP_LOOKBACK_MS;
  const outcome = emptyOutcome();

  let candidates: InFlightRun[];
  try {
    candidates = await listInFlightDispatchedRuns(lookbackMs);
  } catch (err) {
    log.error({ err: String(err) }, 'Warp run watch sweep: could not list in-flight runs');
    return outcome;
  }

  for (const candidate of candidates) {
    outcome.checked += 1;
    try {
      await checkOneRun(candidate, outcome);
    } catch (err) {
      outcome.errors += 1;
      const status = err instanceof WarpApiError ? err.status : undefined;
      log.warn(
        { err: String(err), status, runId: candidate.runId, principalDid: candidate.principalDid },
        'Warp run watch sweep: could not check run',
      );
    }
  }

  return outcome;
}
