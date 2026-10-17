-- Add uploaded_by column for audit trail
ALTER TABLE media.assets ADD COLUMN IF NOT EXISTS uploaded_by TEXT;
CREATE INDEX IF NOT EXISTS idx_assets_uploaded_by ON media.assets(uploaded_by);

-- Backfill: existing uploads were done by the owner
UPDATE media.assets SET uploaded_by = owner_did WHERE uploaded_by IS NULL;
