-- Legacy revocation boundaries stay unknown (timeless/fail-closed).
ALTER TABLE relay.relay_pending_operations
  ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'direct';
ALTER TABLE relay.relay_operation_log
  ADD COLUMN IF NOT EXISTS ingested_at text NOT NULL DEFAULT '';
ALTER TABLE relay.relay_revocations
  ADD COLUMN IF NOT EXISTS signed_created_at text;
ALTER TABLE relay.relay_public_credentials
  ADD COLUMN IF NOT EXISTS signed_created_at text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS ingested_at text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS revoked_by text;
-- revoked_by names the signed revocation retained in relay_operations.
-- Public credential history is hidden, not deleted.
