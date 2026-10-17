-- 0062_vault_delegation_grants.sql
-- Vault delegation grants for owner-sealed secrets (Issue #1242).
--
-- Each row allows a specific recipient (e.g. the cloud node) to unseal a
-- specific vault field without requiring the owner to be online at action time.
-- The `wrapped_key` is the per-field AES-256-GCM seal key, ECDH-wrapped to
-- the recipient's X25519 public key (X25519 ECDH + HKDF-SHA256 + AES-256-GCM).
-- The `owner_signature` covers the canonical grant payload and prevents a
-- compromised node from injecting grants.
--
-- Custody tiers:
--   Tier 0: node X25519 key derived from AUTH_PRIVATE_KEY (same custody as v1,
--           better auditability / revocability).
--   Tier 1: node X25519 key derived from AUTH_PRIVATE_KEY; owner X25519 key
--           held by imajin-cli vault serve / mobile app / Unit — genuine
--           custody separation, owner key never on the cloud node.

CREATE TABLE IF NOT EXISTS kernel.vault_delegation_grants (
  id              TEXT        NOT NULL PRIMARY KEY,
  subject         TEXT        NOT NULL,               -- ownerDid granting access
  granted_to      TEXT        NOT NULL,               -- nodeDid / agentDid receiving access
  field           TEXT        NOT NULL,               -- vault field name (e.g. 'GH_TOKEN')
  owner_x_pub     TEXT        NOT NULL,               -- owner agent X25519 pubkey (32-byte hex)
  wrapped_key     TEXT        NOT NULL,               -- base64: AES-GCM(fieldKey) to grantedTo's X25519
  wrapped_nonce   TEXT        NOT NULL,               -- base64: 12-byte AES-GCM IV
  key_id          TEXT        NOT NULL,               -- vault entry keyId this grant covers
  owner_signature TEXT        NOT NULL,               -- Ed25519 sig over canonical grant payload
  status          TEXT        NOT NULL DEFAULT 'active',  -- 'active' | 'revoked' | 'superseded'
  expires_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at      TIMESTAMPTZ,
  CONSTRAINT uniq_vault_delegation_active UNIQUE (subject, granted_to, field, key_id)
);

-- Primary lookup: node fetches its own active grants for a field at unseal time.
CREATE INDEX IF NOT EXISTS idx_vault_delegation_granted_to_field
  ON kernel.vault_delegation_grants (granted_to, field, status);

-- Subject lookup: owner lists or bulk-revokes their grants.
CREATE INDEX IF NOT EXISTS idx_vault_delegation_subject
  ON kernel.vault_delegation_grants (subject, status);

-- Expiry sweep index for background cleanup of expired active grants.
CREATE INDEX IF NOT EXISTS idx_vault_delegation_expires
  ON kernel.vault_delegation_grants (expires_at)
  WHERE expires_at IS NOT NULL AND status = 'active';
