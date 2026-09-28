-- 0165_app_signing_key_claims.sql
-- owner: kernel
-- #2411 — third-party apps.provision app signing keys: the app fetches its
-- own signing key at boot via a vault delegation grant, authenticated for
-- its FIRST fetch by a one-time, short-TTL claim code shown once on the
-- /jin operator-approval card (Ryan, 2026-09-27, rec (a) on #2411).
--
-- One row per issued claim code. Holds NO secret material — only a SHA-256
-- hash of the plaintext code (`code_hash`), never the code itself. The
-- plaintext is generated in-process, returned exactly once in the
-- operator-approval decision response, and never persisted anywhere.
--
-- `grant_id` points at the (subject=app_did, granted_to=app_did,
-- purpose='app-signing-key') kernel.vault_delegation_grants row this claim
-- authorizes the app to fetch on its first boot — see
-- apps/kernel/src/lib/apps/signing-key-claims.ts.

CREATE TABLE IF NOT EXISTS kernel.app_signing_key_claims (
  id               TEXT PRIMARY KEY,
  slug             TEXT NOT NULL,
  app_did          TEXT NOT NULL,
  grant_id         TEXT NOT NULL,
  code_hash        TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending',
  expires_at       TIMESTAMPTZ NOT NULL,
  claimed_at       TIMESTAMPTZ,
  claimed_by_host  TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE kernel.app_signing_key_claims
  DROP CONSTRAINT IF EXISTS app_signing_key_claims_status_check;

ALTER TABLE kernel.app_signing_key_claims
  ADD CONSTRAINT app_signing_key_claims_status_check CHECK (status IN ('pending', 'claimed', 'expired'));

CREATE UNIQUE INDEX IF NOT EXISTS uniq_app_signing_key_claims_code_hash
  ON kernel.app_signing_key_claims (code_hash);

CREATE INDEX IF NOT EXISTS idx_app_signing_key_claims_app_did_status
  ON kernel.app_signing_key_claims (app_did, status);

CREATE INDEX IF NOT EXISTS idx_app_signing_key_claims_status
  ON kernel.app_signing_key_claims (status);
