-- Phase 1: Create attestations table
CREATE TABLE IF NOT EXISTS auth.attestations (
  id             TEXT PRIMARY KEY,
  issuer_did     TEXT NOT NULL,
  subject_did    TEXT NOT NULL,
  type           TEXT NOT NULL,
  context_id     TEXT,
  context_type   TEXT,
  payload        JSONB,
  signature      TEXT NOT NULL,
  issued_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at     TIMESTAMPTZ,
  revoked_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_auth_attestations_subject ON auth.attestations (subject_did);
CREATE INDEX IF NOT EXISTS idx_auth_attestations_issuer  ON auth.attestations (issuer_did);
CREATE INDEX IF NOT EXISTS idx_auth_attestations_type    ON auth.attestations (type);
