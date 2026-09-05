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
 * in-flight run and publishes the same events the in-request watch would
 * have.
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
 * {@link publishBlockedRunOutcome}, {@link publishTimeoutRunOutcome} — so
 * there is exactly one place that decides what a run's state becomes on the
 * bus. This module only supplies a different *trigger* (a periodic tick
 * instead of an in-process poll loop), the "which runs are still in flight"
 * query, and the decision between "still in flight" and "genuinely timed
 * out" that {@link publishTimeoutRunOutcome} is now reserved for (#2032).
 *
 * ## Finding in-flight runs without a new table
 * `dispatchAgentRun` publishes `warp.agent.dispatched`, and `sendFollowup`'s
 * `resume: true` path publishes `warp.run.resumed` — both entitled by the
 * `warp:dispatch` grant scope (packages/auth/src/grant-scopes.ts) — so
 * `packages/bus`'s event-subscription fan-out (#1884) already writes a
 * durable row to `kernel.event_subscription_log` for each, carrying the
 * `runId` (in `payload`) and the dispatching principal (`subject_did`). That
 * is "already stored kernel-side with the acting principal" from the issue:
 * this sweep reads it rather than introducing a second, parallel place that
 * tracks the same fact.
 *
 * ## Segment-aware in-flight (#2032)
 * A run counts as in-flight when its *latest* `warp.agent.dispatched` or
 * `warp.run.resumed` row is newer than its *latest* terminal row
 * (`warp.run.completed` / `warp.run.failed` / `warp.run.timeout`) for the
 * same `runId` — a timestamp comparison, not mere existence. Before #2032
 * this was an existence check ("has any terminal event ever been logged"),
 * which meant a run resumed after its first segment completed was invisible
 * to this sweep forever: the first segment's `warp.run.completed` row
 * already existed, so the anti-join always excluded it, and the resumed
 * segment's own completion was never observed. See `dispatch.ts`'s module
 * doc for the full picture (timeout-vs-still-running is the other half of
 * #2032).
 *
 * ## Backoff on long runs, and genuine timeout (#2032)
 * `SWEEP_LOOKBACK_MS` is the budget this sweep gives a run before treating a
 * still-non-terminal state as an anomaly rather than something to keep
 * quietly re-polling forever. Before #2032 that boundary was implicit (a
 * `WHERE occurred_at > cutoff` filter on the candidate query simply dropped
 * older runs out of consideration, with no event marking that they were
 * dropped). Now it is explicit: a candidate whose latest activity
 * (dispatch or resume) is older than `SWEEP_LOOKBACK_MS` is read one more
 * time — a stuck run that actually finished should still be reported as
 * such — and only published as `warp.run.timeout` when that read confirms
 * it is still neither terminal nor BLOCKED. This is the "genuinely
 * unresolved" case #2032 asks `warp.run.timeout` to be reserved for,
 * distinct from the in-request watch's own budget elapsing (which is
 * `warp.run.still_running`, not this).
 */
import { getClient } from '@imajin/db';
import { createLogger } from '@imajin/logger';
import {
  getAgentRun,
  isTerminalRunState,
  publishBlockedRunOutcome,
  publishTerminalRunOutcome,
  publishTimeoutRunOutcome,
  WarpApiError,
  type ResumeSegmentContext,
} from './dispatch';

const log = createLogger('kernel');

/**
 * How far back — measured from a run's latest activity (dispatch or resume) —
 * this sweep keeps quietly re-checking a still-non-terminal run before
 * treating it as genuinely timed out (#2032).
 *
 * Six hours comfortably covers the in-request watch's own 30-minute budget
 * plus room for a BLOCKED run to sit waiting on a human across a lunch break,
 * while still bounding how long a truly stuck run goes unreported.
 */
export const SWEEP_LOOKBACK_MS = 6 * 60 * 60 * 1000;

/** One run with no terminal event yet, segment-aware (#2032). */
interface InFlightRun {
  runId: string;
  principalDid: string;
  /** Latest known activity — the newer of its last dispatch or last resume. */
  activityAt: Date;
  /** How many times this run has been resumed via `send_followup resume: true` so far. */
  resumeCount: number;
  /** The prior segment's `sessionId`, from the latest `warp.run.resumed` row, when any exist. */
  previousSessionId: string | null;
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
  /** Past `SWEEP_LOOKBACK_MS` with still no terminal state — published `warp.run.timeout` (#2032). */
  timedOut: number;
  /** Reads or publishes that failed; logged individually, never fatal to the sweep. */
  errors: number;
}

function emptyOutcome(): SweepOutcome {
  return {
    checked: 0,
    completed: 0,
    failed: 0,
    blockedNotified: 0,
    stillInFlight: 0,
    timedOut: 0,
    errors: 0,
  };
}

/**
 * Every run with no terminal event yet, segment-aware (#2032).
 *
 * "In flight" is a timestamp comparison: the latest of a run's
 * `warp.agent.dispatched` and `warp.run.resumed` rows must be newer than its
 * latest terminal row (`warp.run.completed` / `warp.run.failed` /
 * `warp.run.timeout`), or no terminal row exists at all. This is what lets a
 * run resumed after its first segment's completion become visible to the
 * sweep again — a plain "has any terminal event ever existed" anti-join
 * (the pre-#2032 shape) would exclude it forever.
 *
 * Not bounded by `SWEEP_LOOKBACK_MS` here: `kernel.event_subscription_log`
 * already retains only `EVENT_SUBSCRIPTION_RETENTION` (14 days, see
 * packages/auth/src/constants.ts), which bounds the table size on its own.
 * The lookback is instead applied by the caller ({@link checkOneRun}) to each
 * candidate's `activityAt`, so a candidate that has aged past it is still
 * returned here — it is read one more time before being declared timed out,
 * rather than silently dropped from consideration.
 */
async function listInFlightRuns(): Promise<InFlightRun[]> {
  const sql = getClient();

  const rows = await sql`
    WITH dispatch_latest AS (
      SELECT DISTINCT ON (payload->>'runId')
        payload->>'runId' AS run_id,
        subject_did AS principal_did,
        occurred_at AS dispatched_at
      FROM kernel.event_subscription_log
      WHERE event_type = 'warp.agent.dispatched'
        AND payload->>'runId' IS NOT NULL
      ORDER BY payload->>'runId', occurred_at DESC
    ),
    resume_agg AS (
      SELECT
        payload->>'runId' AS run_id,
        COUNT(*) AS resume_count,
        MAX(occurred_at) AS latest_resume_at
      FROM kernel.event_subscription_log
      WHERE event_type = 'warp.run.resumed'
        AND payload->>'runId' IS NOT NULL
      GROUP BY payload->>'runId'
    ),
    resume_latest AS (
      SELECT DISTINCT ON (payload->>'runId')
        payload->>'runId' AS run_id,
        payload->>'previousSessionId' AS previous_session_id
      FROM kernel.event_subscription_log
      WHERE event_type = 'warp.run.resumed'
        AND payload->>'runId' IS NOT NULL
      ORDER BY payload->>'runId', occurred_at DESC
    ),
    terminal_latest AS (
      SELECT
        payload->>'runId' AS run_id,
        MAX(occurred_at) AS terminal_at
      FROM kernel.event_subscription_log
      WHERE event_type IN ('warp.run.completed', 'warp.run.failed', 'warp.run.timeout')
        AND payload->>'runId' IS NOT NULL
      GROUP BY payload->>'runId'
    )
    SELECT
      d.run_id AS "runId",
      d.principal_did AS "principalDid",
      GREATEST(d.dispatched_at, COALESCE(ra.latest_resume_at, d.dispatched_at)) AS "activityAt",
      COALESCE(ra.resume_count, 0) AS "resumeCount",
      rl.previous_session_id AS "previousSessionId"
    FROM dispatch_latest d
    LEFT JOIN resume_agg ra ON ra.run_id = d.run_id
    LEFT JOIN resume_latest rl ON rl.run_id = d.run_id
    LEFT JOIN terminal_latest t ON t.run_id = d.run_id
    WHERE GREATEST(d.dispatched_at, COALESCE(ra.latest_resume_at, d.dispatched_at))
          > COALESCE(t.terminal_at, '-infinity'::timestamptz)
  `;

  const candidates: InFlightRun[] = [];
  for (const row of rows as unknown as Array<{
    runId: unknown;
    principalDid: unknown;
    activityAt: unknown;
    resumeCount: unknown;
    previousSessionId: unknown;
  }>) {
    if (typeof row.runId !== 'string' || typeof row.principalDid !== 'string') continue;
    const activityAt = row.activityAt instanceof Date ? row.activityAt : new Date(String(row.activityAt));
    const resumeCountNumber = typeof row.resumeCount === 'number' ? row.resumeCount : Number(row.resumeCount);
    const resumeCount = Number.isFinite(resumeCountNumber) ? resumeCountNumber : 0;
    const previousSessionId = typeof row.previousSessionId === 'string' ? row.previousSessionId : null;
    candidates.push({ runId: row.runId, principalDid: row.principalDid, activityAt, resumeCount, previousSessionId });
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

/** `candidate`'s resume enrichment for a terminal publish, or undefined for an unresumed run (#2032). */
function resumeContextFor(candidate: InFlightRun): ResumeSegmentContext | undefined {
  if (candidate.resumeCount === 0) return undefined;
  return { resumedFrom: candidate.previousSessionId, segment: candidate.resumeCount + 1 };
}

/**
 * Read `candidate` once and publish whatever the read reveals. Never throws.
 *
 * `lookbackMs` governs the genuinely-timed-out decision (#2032): a candidate
 * whose `activityAt` is older than the lookback is still read here like any
 * other (a stuck run that actually finished must still be reported as such),
 * but if that read is still neither terminal nor BLOCKED, this publishes
 * `warp.run.timeout` instead of silently counting it as in-flight forever.
 */
async function checkOneRun(candidate: InFlightRun, outcome: SweepOutcome, lookbackMs: number): Promise<void> {
  const run = await getAgentRun(candidate.principalDid, candidate.runId);

  if (isTerminalRunState(run.state)) {
    await publishTerminalRunOutcome(candidate.principalDid, run, run.state, resumeContextFor(candidate));
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

  const ageMs = Date.now() - candidate.activityAt.getTime();
  if (ageMs > lookbackMs) {
    await publishTimeoutRunOutcome(candidate.principalDid, candidate.runId, run.state ?? 'UNKNOWN');
    outcome.timedOut += 1;
    return;
  }

  outcome.stillInFlight += 1;
}

/**
 * Sweep every in-flight run once, publishing whichever of
 * `warp.run.completed` / `warp.run.failed` / `warp.run.blocked` /
 * `warp.run.timeout` applies (#2032 widens this from the pre-existing three).
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
    candidates = await listInFlightRuns();
  } catch (err) {
    log.error({ err: String(err) }, 'Warp run watch sweep: could not list in-flight runs');
    return outcome;
  }

  for (const candidate of candidates) {
    outcome.checked += 1;
    try {
      await checkOneRun(candidate, outcome, lookbackMs);
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
