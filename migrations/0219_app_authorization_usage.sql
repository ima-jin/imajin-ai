-- 0219_app_authorization_usage.sql
-- owner: kernel
-- Usage telemetry is deliberately separate from signed attestations.
CREATE TABLE IF NOT EXISTS auth.app_authorization_usage (
  attestation_id text PRIMARY KEY,
  last_used_at timestamptz NOT NULL,
  use_count integer NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_oauth_refresh_attestation_created
  ON auth.oauth_refresh_tokens (attestation_id, created_at);
