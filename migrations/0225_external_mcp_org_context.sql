-- owner: kernel
-- Optional attribution context. Credential custody stays with owner_did.
ALTER TABLE kernel.connectors ADD COLUMN IF NOT EXISTS org_context_did text;
