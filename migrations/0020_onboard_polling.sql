-- Add polling + handoff columns to auth.onboard_tokens for tab-A-canonical email verify

ALTER TABLE auth.onboard_tokens
  ADD COLUMN IF NOT EXISTS poll_handle text UNIQUE,
  ADD COLUMN IF NOT EXISTS handoff_token text UNIQUE,
  ADD COLUMN IF NOT EXISTS handoff_used_at timestamp with time zone;

CREATE INDEX IF NOT EXISTS idx_auth_onboard_tokens_poll_handle
  ON auth.onboard_tokens (poll_handle);

CREATE INDEX IF NOT EXISTS idx_auth_onboard_tokens_handoff_token
  ON auth.onboard_tokens (handoff_token);
