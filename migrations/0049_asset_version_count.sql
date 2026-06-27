-- #1122 Bundle 5: Add version_count to media.assets (version badge)
-- Starts at 1 for all existing assets (backfill) and for new uploads.
-- Incremented by 1 on each successful PUT /content edit.
-- AssetCard shows a "v{N}" badge when version_count > 1.
ALTER TABLE media.assets
  ADD COLUMN IF NOT EXISTS version_count INTEGER NOT NULL DEFAULT 1;
