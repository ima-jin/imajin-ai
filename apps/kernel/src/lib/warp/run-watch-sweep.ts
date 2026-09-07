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
 * have. The followups route now arms its own in-request watch for a
 * resumed segment too (#2055, `WatchRunOptions.resumeContext` in
 * `dispatch.ts`), so this sweep is that resumed segment's safety net in
 * exactly the same sense it always was for a fresh dispatch's segment 1 —
 * not, as before #2055, its *only* path to being observed at all.
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
 *
 * ## Closing the reverse duplicate-publish race (#2043)
 * #1838 added {@link hasTerminalEventForSegment}, a durable-log re-check
 * that closes the sweep-observes-after-the-in-request-watch direction of
 * the race between this sweep and `watchRun` (`dispatch.ts`). The reverse
 * direction — this sweep publishing, then the in-request watch
 * independently publishing moments later for the same segment, because
 * neither's own durable row existed yet for the other to see — is closed
 * by {@link claimTerminalPublish}: a DB-level idempotent claim
 * (`kernel.warp_terminal_publish_claims`, migration 0128) both
 * {@link checkOneRun} and `watchRun` (via `WatchRunOptions.claimTerminalPublish`,
 * injected at the dispatch route's call site so `dispatch.ts` keeps no DB
 * dependency of its own) must win before publishing. `hasTerminalEventForSegment`
 * stays in place as a cheap pre-check — it is a plain `SELECT` and skips a
 * needless claim attempt in the common case — but the claim is now the
 * actual authority.
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
  /**
   * A terminal/timeout publish was skipped because the in-request watch (or an
   * overlapping sweep tick) already published — or already won the claim to
   * publish — this exact segment's outcome, whether that was visible via the
   * durable-log pre-check ({@link hasTerminalEventForSegment}) or only via
   * losing the {@link claimTerminalPublish} race (#2043). Counted separately
   * from `completed`/`failed`/`timedOut` because nothing was published here.
   */
  skippedRace: number;
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
    skippedRace: 0,
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
 * Whether a terminal event for `runId`'s *current* segment has already been
 * published at or after `activityAt` — i.e. since this segment started.
 *
 * Closes a real race between this sweep and the in-request watch
 * (`watchRun`, `dispatch.ts`): both read `getAgentRun` independently and
 * neither previously checked whether the other had already published before
 * calling `publishTerminalRunOutcome`/`publishTimeoutRunOutcome`. A run that
 * survives past one sweep tick while still being watched in-request (common
 * for anything that takes more than a few minutes) could have both the watch
 * and a sweep tick observe the same terminal state within moments of each
 * other and each publish their own `warp.run.completed`/`.failed`/`.timeout`
 * — a real duplicate notification and a real duplicate agent wake downstream
 * (see docs/warp-notification-chain.md, "Incidents 2026-09-05", (c)).
 *
 * `activityAt` (not the sweep tick's own start time) is the right lower bound
 * because it is what identifies *this* segment: an older segment's terminal
 * row must never block a resumed segment's own completion (that was the
 * #2032 bug), so only a terminal row at-or-after the current segment's own
 * activity counts as "already handled".
 */
async function hasTerminalEventForSegment(runId: string, activityAt: Date): Promise<boolean> {
  const sql = getClient();
  const rows = await sql`
    SELECT 1
    FROM kernel.event_subscription_log
    WHERE event_type IN ('warp.run.completed', 'warp.run.failed', 'warp.run.timeout')
      AND payload->>'runId' = ${runId}
      AND occurred_at >= ${activityAt.toISOString()}
    LIMIT 1
  `;
  return rows.length > 0;
}

/**
 * Claim the right to publish a terminal outcome (`warp.run.completed` /
 * `.failed` / `.timeout`) for `runId`'s segment `segment` (#2043).
 *
 * This is the actual race-closing primitive, not merely a pre-check like
 * {@link hasTerminalEventForSegment}: a DB-level idempotent claim via
 * `INSERT ... ON CONFLICT (run_id, segment) DO NOTHING RETURNING`, backed by
 * the `(run_id, segment)` primary key on `kernel.warp_terminal_publish_claims`
 * (migration 0128). Whichever of this sweep ({@link checkOneRun}) or the
 * in-request watch (`watchRun`, `dispatch.ts` — injected via
 * `WatchRunOptions.claimTerminalPublish` so that module keeps no DB
 * dependency of its own) inserts first for a given `(runId, segment)` gets
 * `true` back and owns the publish; the other gets `false` and must skip —
 * even when both observed the same terminal read within moments of each
 * other and neither's own durable `kernel.event_subscription_log` row exists
 * yet for the other to have seen via {@link hasTerminalEventForSegment}.
 *
 * `segment` is 1-based, mirroring {@link ResumeSegmentContext.segment}: the
 * in-request watch claims segment 1 for a fresh dispatch, or
 * `resumeContext.segment` when the followups route re-armed it for a
 * resumed segment (#2055, `WatchRunOptions.resumeContext`, `dispatch.ts`),
 * and {@link checkOneRun} claims `candidate.resumeCount + 1` for whichever
 * segment `candidate` represents.
 */
export async function claimTerminalPublish(
  runId: string,
  segment: number,
  claimedBy: string,
): Promise<boolean> {
  const sql = getClient();
  const rows = await sql`
    INSERT INTO kernel.warp_terminal_publish_claims (run_id, segment, claimed_by)
    VALUES (${runId}, ${segment}, ${claimedBy})
    ON CONFLICT (run_id, segment) DO NOTHING
    RETURNING run_id
  `;
  return rows.length > 0;
}

/**
 * Count of `warp.run.resumed` events already durably logged for `runId`
 * (#2055) — used by the followups route to compute the segment number for
 * the in-request watch it re-arms right after an accepted resume (see
 * `WatchRunOptions.resumeContext`, `dispatch.ts`): segment `N` is
 * `countPriorResumes(runId) + 2` for the resume the route is *currently*
 * handling (mirrors `resumeContextFor`'s `resumeCount + 1` for a run's
 * *current* segment, one higher because this counts resumes strictly
 * before the one in flight).
 *
 * Deliberately called by the route BEFORE it calls `sendFollowup`, not
 * after: `publish()`'s durable-log write is fire-and-forget
 * (`deliverToSubscribers`, `packages/bus/src/publish.ts`), so counting
 * immediately after this resume's own `warp.run.resumed` publish could race
 * that write and undercount. Counting before this resume is requested has
 * no such race — it only ever counts resumes that already happened.
 */
export async function countPriorResumes(runId: string): Promise<number> {
  const sql = getClient();
  const rows = await sql`
    SELECT COUNT(*)::int AS count
    FROM kernel.event_subscription_log
    WHERE event_type = 'warp.run.resumed'
      AND payload->>'runId' = ${runId}
  `;
  const row = rows[0] as { count?: unknown } | undefined;
  const count = typeof row?.count === 'number' ? row.count : Number(row?.count);
  return Number.isFinite(count) ? count : 0;
}

/**
 * Whether the sweep may publish a terminal/timeout outcome for this segment
 * right now (#2043): {@link hasTerminalEventForSegment} first, as a cheap
 * pre-check, then {@link claimTerminalPublish} as the actual authority.
 * Factored out of {@link checkOneRun} since both of its terminal-shaped
 * branches (a genuinely terminal read, and a genuinely-timed-out one) need
 * exactly this same guard before publishing.
 */
async function mayPublishTerminalOutcome(runId: string, activityAt: Date, segment: number): Promise<boolean> {
  if (await hasTerminalEventForSegment(runId, activityAt)) return false;
  return claimTerminalPublish(runId, segment, 'sweep');
}

/**
 * Read `candidate` once and publish whatever the read reveals. Never throws.
 *
 * `lookbackMs` governs the genuinely-timed-out decision (#2032): a candidate
 * whose `activityAt` is older than the lookback is still read here like any
 * other (a stuck run that actually finished must still be reported as such),
 * but if that read is still neither terminal nor BLOCKED, this publishes
 * `warp.run.timeout` instead of silently counting it as in-flight forever.
 *
 * Before either terminal-shaped publish, {@link mayPublishTerminalOutcome}
 * re-checks the durable log as a cheap pre-check and then wins (or loses)
 * the {@link claimTerminalPublish} race (#2043): a candidate that the
 * in-request watch already finalised, or has already won the claim for, is
 * skipped rather than double-published (see that function's doc for the
 * race this closes).
 */
async function checkOneRun(candidate: InFlightRun, outcome: SweepOutcome, lookbackMs: number): Promise<void> {
  const run = await getAgentRun(candidate.principalDid, candidate.runId);
  const segment = candidate.resumeCount + 1;

  if (isTerminalRunState(run.state)) {
    if (!(await mayPublishTerminalOutcome(candidate.runId, candidate.activityAt, segment))) {
      outcome.skippedRace += 1;
      return;
    }
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
    if (!(await mayPublishTerminalOutcome(candidate.runId, candidate.activityAt, segment))) {
      outcome.skippedRace += 1;
      return;
    }
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
