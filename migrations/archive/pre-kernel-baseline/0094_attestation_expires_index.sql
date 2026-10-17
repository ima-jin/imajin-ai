-- =============================================================================
-- 0092_attestation_expires_index.sql — Partial index on auth.attestations.expires_at
-- =============================================================================
--
-- Enables efficient cleanup of expired attestations by the attestation-cleanup
-- cron job. Only indexes rows where expires_at IS NOT NULL, which are the
-- minority of attestations that opt into automatic retention.
--
-- This is the first attestation type with automatic retention (agent.turn.usage,
-- 90-day rolling). Other high-volume types can opt in by setting expires_at at
-- creation time; no schema or index changes are required.

CREATE INDEX IF NOT EXISTS idx_auth_attestations_expires
  ON auth.attestations (expires_at)
  WHERE expires_at IS NOT NULL;
