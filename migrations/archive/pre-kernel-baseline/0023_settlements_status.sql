-- Add status column to media.settlements (#883)
-- Separate migration since 0022 may have already run on dev.
-- Values: 'pending' | 'completed'

ALTER TABLE media.settlements
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending';
