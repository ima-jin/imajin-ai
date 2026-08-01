-- 0078_vault_owner_envelopes.sql
-- Owner envelopes + self-describing delegation grants (#1521, #1242 Phase 2 follow-on).
--
-- Turns a delegation grant from a permanent handover into a revocable, expirable
-- lease, and makes a sealed profile portable to a different node.
--
-- ## Why an owner envelope
--
-- A v2 entry is encrypted with a random per-field AES key. That key currently
-- survives in exactly two places: the delegation grant (wrapped to the node) and
-- — incidentally — the fulfilled vault_grant_requests row (wrapped to the owner).
-- Nothing documented that second one, so routine housekeeping on the request
-- queue would have silently destroyed the owner's only recoverable copy of every
-- field key.
--
-- vault_owner_envelopes makes that copy explicit and durable. It holds the field
-- key ECDH-wrapped to the OWNER's X25519 pubkey, so only the owner can open it.
-- vault-core's primitives are wrapFieldKey(fieldKey, recipientXPub, senderXPriv)
-- and unwrapFieldKey(wrapped, senderXPub, recipientXPriv), so the envelope is
-- written as wrapFieldKey(fieldKey, ownerXPub, nodeXPriv) and opened with:
--   unwrapFieldKey({ encryptedKey: wrapped_key, nonce: wrapped_nonce },
--                  sender_x_pub, ownerXPriv)
-- sender_x_pub is therefore the WRAPPER's pubkey (the node), not the owner's.
--
-- With the envelope in place the owner can, without any cooperation from the node:
--   - re-issue a grant after expiry or revocation (renewal), and
--   - issue a grant to a DIFFERENT recipient (porting to a new node).
--
-- It is also the safety precondition for crypto-erasing a grant's wrapped key:
-- erase is only permitted when an envelope exists for the same (field, key_id),
-- so revocation can never destroy the last recoverable copy.
--
-- ## Why the new grant columns
--
-- recipient_x_pub: vault_delegation_grants recorded owner_x_pub but not the
--   recipient's X25519 pubkey, so a grant row could not be opened by the owner
--   on its own — ECDH needs the counterparty pubkey. Grants are now
--   self-describing.
--
-- owner_ed_pub: loadAndUnseal chose the signature verifier from a PROCESS-WIDE
--   flag (Tier 1 → VAULT_OWNER_ED_PUB, otherwise entry.senderPubkey). That made
--   Tier 1 a one-way door: unsetting the env made every Tier-1-sealed entry fail
--   verification. Pinning the expected verifier on the grant itself lets Tier-0
--   and Tier-1 grants coexist and survive a config change.
--
-- Both columns are nullable: existing rows predate them and fall back to the
-- previous behaviour.

CREATE TABLE IF NOT EXISTS kernel.vault_owner_envelopes (
  id               TEXT        PRIMARY KEY,             -- vwe_{nanoid}
  field            TEXT        NOT NULL,                -- vault field name, e.g. 'github-oauth:did:imajin:...'
  key_id           TEXT        NOT NULL,                -- keyId of the vault entry this envelope covers
  owner_x_pub      TEXT        NOT NULL,                -- owner's X25519 pubkey the key is wrapped TO
  sender_x_pub     TEXT        NOT NULL,                -- wrapper's X25519 pubkey (the node); ECDH counterparty for unwrap
  wrapped_key      TEXT        NOT NULL,                -- base64: fieldKey wrapped to owner_x_pub
  wrapped_nonce    TEXT        NOT NULL,                -- base64: 12-byte AES-GCM IV for wrapped_key
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One envelope per (field, key_id). Note key_id identifies the SIGNING KEY, not the
-- entry: it is derived from the node's Ed25519 pubkey and is therefore constant
-- across re-seals by the same node. So this row is upserted on re-seal and always
-- holds the CURRENT generation's field key.
--
-- That is deliberate. A superseded generation's field key is intentionally not
-- retained, so re-sealing crypto-erases the previous value rather than leaving an
-- owner-openable copy of every secret the field has ever held.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_vault_owner_envelope
  ON kernel.vault_owner_envelopes (field, key_id);

-- Lookup used by the erase guard and by owner-side renewal/porting.
CREATE INDEX IF NOT EXISTS idx_vault_owner_envelopes_field
  ON kernel.vault_owner_envelopes (field);

-- Self-describing grants: recipient pubkey for ECDH, and the pinned verifier.
ALTER TABLE kernel.vault_delegation_grants
  ADD COLUMN IF NOT EXISTS recipient_x_pub TEXT;

ALTER TABLE kernel.vault_delegation_grants
  ADD COLUMN IF NOT EXISTS owner_ed_pub TEXT;
