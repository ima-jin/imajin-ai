-- 0150_vault_mint.sql
-- owner: kernel
--
-- #2242: vault.mint — an Ed25519 keypair generated INSIDE the kernel vault,
-- sealed via the existing v2 delegation-grant custody path (#1439/#2231's
-- sealAndGrantStaticSecret). This migration adds the bookkeeping table for
-- that mint action; it does NOT introduce any new key-material storage —
-- the sealed private key lives in the ordinary vault entry, reached only
-- through a kernel.vault_delegation_grants row (grantId).
--
--   did          -- the newly minted DID (unique)
--   public_key   -- hex Ed25519 public key
--   field        -- vault field holding the sealed private key
--   purpose      -- free-form label naming what the key is for
--   requested_by -- grantee DID the sealed key was delivered to
--   minted_by    -- acting principal who called mint (requireAuth/actingFor)
--   grant_id     -- kernel.vault_delegation_grants.id; null under Tier 1
--                   pending grant
--   status       -- 'active' | 'revoked'
--   revoked_at / revoked_by -- set on revoke; the row survives as a soft
--                   tombstone (v1) recording that a key existed and was
--                   revoked — see apps/kernel/src/lib/vault/mint.ts.
--
-- This table number picked as the next free slot after 0148 (#2231) and the
-- in-flight 0149 (#2235 grant-ack, not yet merged at the time this was
-- authored) — coordinated per the #2241 epic body.
--
-- Also seeds the `kernel.bus_chain_configs` rows for the new
-- `vault.key.minted` / `vault.key.revoked` audit events the mint/revoke
-- routes publish -- kept in sync with the packages/bus/src/config.ts
-- DEFAULTS entries, following the reconcile convention established by
-- migration 0098 (and reused by 0148).
--
-- ADDITIVE ONLY.

CREATE TABLE IF NOT EXISTS kernel.vault_minted_keys (
  id TEXT PRIMARY KEY,
  did TEXT NOT NULL,
  public_key TEXT NOT NULL,
  field TEXT NOT NULL,
  purpose TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  minted_by TEXT NOT NULL,
  grant_id TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  revoked_by TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_vault_minted_keys_did
  ON kernel.vault_minted_keys (did);

CREATE INDEX IF NOT EXISTS idx_vault_minted_keys_field
  ON kernel.vault_minted_keys (field);

CREATE INDEX IF NOT EXISTS idx_vault_minted_keys_requested_by
  ON kernel.vault_minted_keys (requested_by, status);

INSERT INTO kernel.bus_chain_configs (event_type, scope, reactors, enabled)
VALUES (
  'vault.key.minted',
  NULL,
  '[{"type":"audit-log","config":{"fields":["mintId","did","publicKey","field","purpose","requestedBy","mintedBy","grantId"]},"enabled":true}]'::jsonb,
  true
)
ON CONFLICT (event_type, scope) DO UPDATE
  SET reactors = EXCLUDED.reactors,
      updated_at = now();

INSERT INTO kernel.bus_chain_configs (event_type, scope, reactors, enabled)
VALUES (
  'vault.key.revoked',
  NULL,
  '[{"type":"audit-log","config":{"fields":["mintId","did","publicKey","revokedBy"]},"enabled":true}]'::jsonb,
  true
)
ON CONFLICT (event_type, scope) DO UPDATE
  SET reactors = EXCLUDED.reactors,
      updated_at = now();
