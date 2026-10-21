-- 0038: Deduplicate relay_operation_log and add unique constraint on cid
--
-- Bug: appendToLog did not guard against duplicate CIDs. Sync/retry cycles
-- inserted the same operation multiple times. Cursor resolution (readLog)
-- picked an arbitrary seq for a given cid, sometimes the earlier duplicate,
-- causing pagination to cycle backwards instead of converging.
--
-- Fix: remove duplicate rows (keep lowest seq per cid), add unique index.
-- Ref: Brandon's bug report 2026-06-16, metalabel/dfos#75

BEGIN;

-- Delete duplicate rows, keeping the one with the lowest seq per cid
DELETE FROM relay.relay_operation_log
WHERE seq NOT IN (
  SELECT MIN(seq)
  FROM relay.relay_operation_log
  GROUP BY cid
);

-- Add unique index on cid to prevent future duplicates
CREATE UNIQUE INDEX IF NOT EXISTS uq_relay_operation_log_cid
  ON relay.relay_operation_log (cid);

COMMIT;
