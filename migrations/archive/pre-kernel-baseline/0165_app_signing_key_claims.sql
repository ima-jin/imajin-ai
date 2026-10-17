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
--
-- `bootstrap_public_key` / `bootstrap_key_revoked_at` (Ryan, restart-
-- authentication ruling, ~2026-09-28): at claim time the app also submits
-- an Ed25519 bootstrap keypair it minted and persisted in its own local
-- keystore file. The kernel binds that keypair's PUBLIC half to this claim
-- row so every LATER boot can re-authenticate a grant fetch by signing a
-- fresh challenge with the bootstrap private key, instead of spending a
-- second one-time claim code. `bootstrap_key_revoked_at` is set when a
-- newer claim for the same app_did supersedes this binding (operator
-- re-approving `apps.provision` with `reissueClaim: true` to rebind a lost
-- keystore) — a revoked binding can never again authenticate a fetch, even
-- though the row's own `status` stays `'claimed'` as the historical record.

CREATE TABLE IF NOT EXISTS kernel.app_signing_key_claims (
  id                       TEXT PRIMARY KEY,
  slug                     TEXT NOT NULL,
  app_did                  TEXT NOT NULL,
  grant_id                 TEXT NOT NULL,
  code_hash                TEXT NOT NULL,
  status                   TEXT NOT NULL DEFAULT 'pending',
  expires_at               TIMESTAMPTZ NOT NULL,
  claimed_at               TIMESTAMPTZ,
  claimed_by_host          TEXT,
  -- Hex-encoded Ed25519 public key of the app's own bootstrap keypair,
  -- bound at claim time. Never the private key — that never leaves the
  -- app's local keystore file.
  bootstrap_public_key     TEXT,
  bootstrap_key_revoked_at TIMESTAMPTZ,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now()
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

-- Resolve the currently-active bootstrap-key binding for an app_did (used
-- on every subsequent-boot fetch — see
-- apps/kernel/src/lib/apps/bootstrap-fetch-auth.ts).
CREATE INDEX IF NOT EXISTS idx_app_signing_key_claims_app_did_binding
  ON kernel.app_signing_key_claims (app_did)
  WHERE bootstrap_public_key IS NOT NULL AND bootstrap_key_revoked_at IS NULL;
