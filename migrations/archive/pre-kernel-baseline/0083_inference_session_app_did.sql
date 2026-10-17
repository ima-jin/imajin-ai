-- Migration: 0083_inference_session_app_did
-- Adds optional app/org DID credential-owner metadata to inference.sessions (#1624).
--
-- owner_did remains the attribution and consent subject. app_did records the
-- invoking app/org DID when that DID may provide the sealed inference credential
-- used for policy execution.

ALTER TABLE inference.sessions
  ADD COLUMN IF NOT EXISTS app_did text;

CREATE INDEX IF NOT EXISTS idx_inference_sessions_app
  ON inference.sessions (app_did);
