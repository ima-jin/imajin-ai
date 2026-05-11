-- Add DFOS event ID column to media.assets for .fair manifest federation anchor
ALTER TABLE media.assets ADD COLUMN IF NOT EXISTS fair_dfos_event_id TEXT;
