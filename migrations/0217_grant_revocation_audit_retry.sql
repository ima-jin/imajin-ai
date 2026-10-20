-- owner: kernel
-- #2997 review ruling b: revoke authority before signing its audit record.
-- Retry intent lives on the authority row so an unavailable signer/history
-- store cannot block revocation, and a process restart cannot lose its actor.
ALTER TABLE auth.delegation_grants
  ADD COLUMN IF NOT EXISTS pending_revocation_audits jsonb NOT NULL DEFAULT '[]'::jsonb;

CREATE INDEX IF NOT EXISTS idx_delegation_grants_pending_revocation_audits
  ON auth.delegation_grants (id)
  WHERE pending_revocation_audits <> '[]'::jsonb;
