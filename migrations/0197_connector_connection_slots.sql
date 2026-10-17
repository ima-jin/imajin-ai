-- #2365: installations, grants, and Google operational cursors are per connection.
-- owner: kernel
-- Existing rows become primary in place. IDs, channel UIDs and vault field
-- references are deliberately untouched: no credential re-seal is required.
ALTER TABLE kernel.connectors ADD COLUMN IF NOT EXISTS slot text NOT NULL DEFAULT 'primary';
ALTER TABLE kernel.connectors ADD COLUMN IF NOT EXISTS label text;
ALTER TABLE kernel.connectors ADD COLUMN IF NOT EXISTS account_email text;
ALTER TABLE kernel.connectors DROP CONSTRAINT IF EXISTS uniq_connectors_owner_provider;
DROP INDEX IF EXISTS kernel.uniq_connectors_owner_provider;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_connectors_owner_provider_slot
  ON kernel.connectors (owner_did, provider, slot);

ALTER TABLE auth.channel_links ADD COLUMN IF NOT EXISTS slot text NOT NULL DEFAULT 'primary';
CREATE INDEX IF NOT EXISTS idx_channel_links_slot
  ON auth.channel_links (did, channel, slot, status);
-- The channel/channel_uid/app_did conflict target remains valid because each
-- connection publishes its own manifest asset, hence distinct channel UIDs.

ALTER TABLE kernel.google_workspace_state ADD COLUMN IF NOT EXISTS slot text NOT NULL DEFAULT 'primary';
ALTER TABLE kernel.google_workspace_state ADD COLUMN IF NOT EXISTS account_email text;
DROP INDEX IF EXISTS kernel.uniq_google_workspace_state_owner;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_google_workspace_state_owner_slot
  ON kernel.google_workspace_state (owner_did, slot);

ALTER TABLE kernel.quickbooks_realm_index ADD COLUMN IF NOT EXISTS slot text NOT NULL DEFAULT 'primary';
ALTER TABLE github.action_proposals ADD COLUMN IF NOT EXISTS slot text NOT NULL DEFAULT 'primary';
