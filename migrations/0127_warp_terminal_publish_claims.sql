-- 0127_warp_terminal_publish_claims.sql
-- Close the reverse poller/sweep duplicate-publish race (#2043) — the
-- direction #1838's `hasTerminalEventForSegment` re-check (migration 0111,
-- run-watch-sweep.ts) did not close: the sweep publishing a terminal
-- `warp.run.*` outcome for a run's segment, then the in-request watch
-- (`watchRun`, apps/kernel/src/lib/warp/dispatch.ts) independently
-- observing the same terminal state moments later and publishing its own
-- duplicate, because `watchRun`'s own terminal branch had no equivalent
-- guard.
--
-- This is a DB-level idempotent claim, not an advisory lock: whichever of
-- the sweep (`checkOneRun`) or the in-request watch (`watchRun`) first
-- succeeds an `INSERT ... ON CONFLICT (run_id, segment) DO NOTHING
-- RETURNING` against this table owns the publish for that run's segment;
-- the other gets zero rows back and skips — even when neither's own
-- `kernel.event_subscription_log` row exists yet for the other to have
-- seen via `hasTerminalEventForSegment`. See `claimTerminalPublish`
-- (apps/kernel/src/lib/warp/run-watch-sweep.ts), the one shared helper both
-- callers use — injected into `watchRun` via `WatchRunOptions` rather than
-- imported directly into dispatch.ts, since that module documents itself
-- as having no DB dependency by design.
--
-- `segment` is 1-based (mirrors `ResumeSegmentContext.segment` in
-- dispatch.ts): the in-request watch always claims segment 1 (it can only
-- ever watch a run's first, unresumed segment), and the sweep claims
-- `resumeCount + 1` for whichever segment its candidate represents — so a
-- resumed run's later segment claims its own row rather than colliding
-- with an earlier segment's.
--
-- Rows are retained (no TTL/cleanup here) — one row per (run_id, segment)
-- ever finalised is bounded by the number of runs/segments this kernel has
-- ever dispatched, the same growth profile as the terminal rows already
-- kept in kernel.event_subscription_log.
CREATE TABLE IF NOT EXISTS kernel.warp_terminal_publish_claims (
  run_id      TEXT        NOT NULL,
  segment     INTEGER     NOT NULL,
  claimed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  claimed_by  TEXT        NOT NULL,
  PRIMARY KEY (run_id, segment)
);
