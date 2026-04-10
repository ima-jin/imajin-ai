-- Add scope_did column to onboard_tokens (was in schema but never migrated)
ALTER TABLE auth.onboard_tokens ADD COLUMN IF NOT EXISTS scope_did TEXT;
