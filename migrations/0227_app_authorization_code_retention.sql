-- owner: kernel
-- Match the sweep's death-time predicate: consumption takes precedence over expiry.
CREATE INDEX IF NOT EXISTS idx_app_authorization_codes_retention
  ON auth.app_authorization_codes (coalesce(consumed_at, expires_at));
