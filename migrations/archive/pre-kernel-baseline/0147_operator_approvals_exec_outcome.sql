-- 0147_operator_approvals_exec_outcome.sql
-- owner: kernel
--
-- #2221: exec.command approval kind — post-exec outcome follow-up
-- (exit code, duration, output hash) attached to the approval record so
-- /jin can show wish -> grant -> what actually ran. Additive only, per
-- migrations/OWNERSHIP.md (kernel owns the `operator` schema):
--
--   outcome — nullable jsonb, shape { exitCode, durationMs, outputHash }.
--             Populated by POST /notify/api/internal/operator-approvals/
--             outcome once the OpenClaw gateway reports the finished exec
--             back to the bridge. No other kind populates this today.
--
-- Numbers 0145/0146 are claimed by in-flight PRs (#2216/#2218) — this
-- migration is 0147 to avoid colliding with them.

ALTER TABLE operator.approvals
  ADD COLUMN IF NOT EXISTS outcome jsonb;
