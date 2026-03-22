-- Add content addressing + countersignature fields to attestations
ALTER TABLE auth.attestations
  ADD COLUMN IF NOT EXISTS cid TEXT,
  ADD COLUMN IF NOT EXISTS author_jws TEXT,
  ADD COLUMN IF NOT EXISTS witness_jws TEXT,
  ADD COLUMN IF NOT EXISTS attestation_status TEXT DEFAULT 'pending';

-- Index for status filtering
CREATE INDEX IF NOT EXISTS idx_auth_attestations_status
  ON auth.attestations (attestation_status);
