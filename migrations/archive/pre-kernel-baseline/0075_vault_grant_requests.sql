-- 0075_vault_grant_requests.sql
-- Tier 1 vault custody: pending grant request queue for the external owner agent (#1403).
--
-- Under Tier 1, sealAndStoreV2 cannot create a self-grant (ownerXPriv lives on
-- the operator's machine, not the cloud node). Instead it:
--   1. Writes the vault entry as normal.
--   2. Wraps the per-field AES key from nodeXPriv → ownerXPub and inserts a row
--      here with status='pending'.
--   3. Emits vault.grant.requested so the owner agent (imajin-cli vault serve)
--      can poll, recover the field key, re-wrap it as the canonical delegation
--      grant, sign it, and POST to POST /api/vault/delegation/grant.
--   4. That endpoint verifies the owner signature and inserts the real
--      vault_delegation_grants row, then marks this request fulfilled.
--
-- wrappedFieldKey / wrappedFieldKeyNonce:
--   The field key is ECDH-wrapped from nodeXPriv to ownerXPub using the same
--   wrapFieldKey primitive from vault-core. Only the owner (who holds ownerXPriv)
--   can recover the raw field key by calling unwrapFieldKey(wrapped, nodeXPub, ownerXPriv).

CREATE TABLE IF NOT EXISTS kernel.vault_grant_requests (
  id                       TEXT        PRIMARY KEY,             -- vgr_{nanoid}
  field                    TEXT        NOT NULL,                -- vault field name, e.g. 'GH_TOKEN'
  key_id                   TEXT        NOT NULL,                -- keyId of the corresponding vault entry
  request_id               TEXT        NOT NULL,                -- UUID correlation ID (unique per request)
  node_x_pub               TEXT        NOT NULL,                -- node's X25519 pubkey (32-byte hex)
  owner_x_pub              TEXT        NOT NULL,                -- expected owner's X25519 pubkey
  wrapped_field_key        TEXT        NOT NULL,                -- base64: fieldKey wrapped nodeXPriv→ownerXPub
  wrapped_field_key_nonce  TEXT        NOT NULL,                -- base64: 12-byte AES-GCM IV for the above
  status                   TEXT        NOT NULL DEFAULT 'pending', -- 'pending' | 'fulfilled' | 'expired'
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at               TIMESTAMPTZ,
  fulfilled_at             TIMESTAMPTZ,
  grant_id                 TEXT                                 -- FK → vault_delegation_grants.id once fulfilled
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_vault_grant_request_id
  ON kernel.vault_grant_requests (request_id);

CREATE INDEX IF NOT EXISTS idx_vault_grant_requests_status
  ON kernel.vault_grant_requests (status);

CREATE INDEX IF NOT EXISTS idx_vault_grant_requests_field_status
  ON kernel.vault_grant_requests (field, status);
