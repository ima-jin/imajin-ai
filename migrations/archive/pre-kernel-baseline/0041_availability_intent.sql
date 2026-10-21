-- 0041_availability_intent.sql
-- Availability intent fields for kernel.calendar_entries (Issue #1099)
-- Adds the availability-specific columns onto the base row from #241.
-- Other entry types (meeting, event, booking, reminder) carry these columns
-- but leave them null — cheap to store, avoids a typed-metadata split for now.

ALTER TABLE kernel.calendar_entries
  ADD COLUMN IF NOT EXISTS intent        TEXT,          -- availability switch, e.g. 'going_out'
  ADD COLUMN IF NOT EXISTS sensitive_tags TEXT[],       -- subset of activity_tags flagged sensitive
  ADD COLUMN IF NOT EXISTS reach         TEXT NOT NULL DEFAULT 'favourites';
                                                        -- 'favourites' | 'one_degree' | 'strangers'

-- Partial index for the match engine (#1102): scan live availability notes efficiently.
CREATE INDEX IF NOT EXISTS idx_calendar_entries_live
  ON kernel.calendar_entries (type, expires_at)
  WHERE expires_at IS NOT NULL;
