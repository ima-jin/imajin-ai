-- owner: kernel
-- Org-held credentials use a separate slot; personal resolution is unchanged.
ALTER TABLE kernel.connectors ADD COLUMN IF NOT EXISTS loaded_by_did text;
ALTER TABLE kernel.connectors ADD COLUMN IF NOT EXISTS loaded_at timestamptz;
