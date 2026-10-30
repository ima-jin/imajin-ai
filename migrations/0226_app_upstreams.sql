-- owner: kernel
-- App declarations extend the existing registry; credentials remain member-owned.
ALTER TABLE registry.apps ADD COLUMN IF NOT EXISTS upstreams jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE kernel.connectors ADD COLUMN IF NOT EXISTS upstream_binding text;
