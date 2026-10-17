-- 0080_github_proposal_expiry.sql
-- Retire lapsed GitHub approval windows so they stop shadowing live ones (#1588).
--
-- ## The bug
--
-- 0073 gave windowed approvals a deliberate lifecycle quirk: the 'approved' row
-- stays active and each execution under the window inserts a *separate* 'done'
-- row. Nothing then moves that approval row off 'approved' when its TTL lapses,
-- because no other transition owns it -- single-call approvals become 'done',
-- denials become 'denied', but a lapsed window is nobody's job.
--
-- The live-grant lookup in requireWriteGate() compounded it:
--
--   WHERE owner_did=? AND scope=? AND risk_tier=? AND status='approved'
--   LIMIT 1
--
-- No expiry predicate, and no ORDER BY under a LIMIT 1, so Postgres returns an
-- arbitrary matching row. Expiry was then checked in JS on whichever single row
-- came back. Once one stranded lapsed window existed for a tuple it could be
-- returned on every subsequent call, the JS check saw a dead window, and the
-- gate re-proposed -- even though a freshly approved live window sat in the same
-- table. That is the approve-then-retry loop Eric hit: each cycle minted a new
-- proposal id and the approval never matched, six rounds straight, and setting a
-- 24h window before the retry changed nothing because the query never looked at
-- the new row.
--
-- ## The fix
--
-- Code side (apps/kernel/src/lib/github/connector.ts): the lookup now scans a
-- bounded newest-first page instead of LIMIT 1, partitions live from lapsed, and
-- retires lapsed windows as it goes.
--
-- Data side (here): retire the rows already stranded in production, and widen the
-- gate index to cover the scan's ordering.
--
-- 'expired' is used rather than 'done' on purpose. countDoneProposals() reads
-- 'done' as "a write executed" for rate-limit accounting, so folding unused
-- lapsed windows into 'done' would silently burn the owner's hourly write budget.

-- Retire every windowed approval whose TTL has already lapsed. Single-call
-- approvals (approved_until IS NULL) are untouched: they never lapse, they are
-- consumed by the next write.
UPDATE github.action_proposals
   SET status = 'expired',
       updated_at = now()
 WHERE status = 'approved'
   AND approved_until IS NOT NULL
   AND approved_until <= now();

-- Widen the gate index with created_at so the newest-first approval scan is an
-- ordered index scan rather than a sort over the tuple's matching rows.
DROP INDEX IF EXISTS github.idx_github_action_proposals_gate;

CREATE INDEX IF NOT EXISTS idx_github_action_proposals_gate
  ON github.action_proposals (owner_did, scope, risk_tier, status, created_at DESC);
