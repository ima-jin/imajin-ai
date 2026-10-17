-- Migration: Multi-party attestation signatures + document signing support

-- 1. New table for attestation signatures
CREATE TABLE IF NOT EXISTS auth.attestation_signatures (
  id TEXT PRIMARY KEY,
  attestation_id TEXT NOT NULL REFERENCES auth.attestations(id) ON DELETE CASCADE,
  signer_did TEXT NOT NULL,
  jws TEXT,
  signed_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'pending',
  role TEXT NOT NULL DEFAULT 'signer',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_attestation_sigs_att ON auth.attestation_signatures(attestation_id);
CREATE INDEX IF NOT EXISTS idx_attestation_sigs_signer ON auth.attestation_signatures(signer_did);
CREATE INDEX IF NOT EXISTS idx_attestation_sigs_status ON auth.attestation_signatures(status);

-- 2. Add document signing columns to attestations
ALTER TABLE auth.attestations
  ADD COLUMN IF NOT EXISTS document_hash TEXT,
  ADD COLUMN IF NOT EXISTS document_asset_id TEXT,
  ADD COLUMN IF NOT EXISTS total_signers INTEGER;

-- 3. Add immutability flag to media.assets
ALTER TABLE media.assets
  ADD COLUMN IF NOT EXISTS immutable BOOLEAN DEFAULT FALSE;

-- 4. Backfill existing bilateral attestations into attestation_signatures
-- (idempotent: only inserts where no signature row exists for that attestation+signer)
INSERT INTO auth.attestation_signatures (id, attestation_id, signer_did, jws, signed_at, status, role, created_at)
SELECT
  'sig_' || encode(gen_random_bytes(12), 'hex'),
  a.id,
  a.issuer_did,
  a.author_jws,
  a.issued_at,
  'signed',
  'creator',
  a.issued_at
FROM auth.attestations a
WHERE a.author_jws IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM auth.attestation_signatures s
    WHERE s.attestation_id = a.id AND s.signer_did = a.issuer_did
  );

INSERT INTO auth.attestation_signatures (id, attestation_id, signer_did, jws, signed_at, status, role, created_at)
SELECT
  'sig_' || encode(gen_random_bytes(12), 'hex'),
  a.id,
  a.subject_did,
  a.witness_jws,
  a.issued_at,
  'signed',
  'signer',
  a.issued_at
FROM auth.attestations a
WHERE a.witness_jws IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM auth.attestation_signatures s
    WHERE s.attestation_id = a.id AND s.signer_did = a.subject_did
  );
