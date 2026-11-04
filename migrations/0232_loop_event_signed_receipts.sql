-- owner: kernel
-- Additive receipt evidence only. Historical unsigned rows remain unsigned.
ALTER TABLE kernel.loop_events
  ADD COLUMN IF NOT EXISTS signature jsonb,
  ADD COLUMN IF NOT EXISTS publisher_did text,
  ADD COLUMN IF NOT EXISTS cause_event_id text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'kernel.loop_events'::regclass
      AND conname = 'loop_events_cause_event_id_fkey'
  ) THEN
    ALTER TABLE kernel.loop_events
      ADD CONSTRAINT loop_events_cause_event_id_fkey
      FOREIGN KEY (cause_event_id) REFERENCES kernel.loop_events(id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_loop_events_cause_event_id
  ON kernel.loop_events (cause_event_id);
