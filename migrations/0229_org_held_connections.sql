-- owner: kernel
-- Org-held credentials use a separate provider namespace; personal resolution is unchanged.
ALTER TABLE kernel.connectors ADD COLUMN IF NOT EXISTS loaded_by_did text;
ALTER TABLE kernel.connectors ADD COLUMN IF NOT EXISTS loaded_at timestamptz;
