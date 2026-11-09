-- owner: kernel
-- #3023: apply only after the operator's read-only production preflight
-- scripts/sql/app-authorization-surplus.sql reports surplus_count = 0.
-- Expired-but-unrevoked grants count. Any cleanup belongs to the operator
-- through signed revocation, never deletion or an unsigned migration update.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_auth_attestations_unrevoked_app_grant
  ON auth.attestations (issuer_did, subject_did)
  WHERE type = 'app.authorized' AND revoked_at IS NULL;
