-- 0072_supply_stages_seq.sql
-- Add a monotonic insertion-order sequence to supply_stages so ORDER BY can use
-- seq DESC as a deterministic tiebreaker instead of the random-UUID id column.
-- The existing id column is gen_random_uuid()::text (v4), which is non-monotonic
-- and yields an arbitrary tiebreak when two stages share the same created_at
-- millisecond.  seq is BIGSERIAL so it is guaranteed to increase with each insert.

ALTER TABLE kernel.supply_stages
  ADD COLUMN IF NOT EXISTS seq BIGSERIAL NOT NULL;

CREATE INDEX IF NOT EXISTS idx_supply_stages_correlation_seq
  ON kernel.supply_stages (correlation_id, seq);
