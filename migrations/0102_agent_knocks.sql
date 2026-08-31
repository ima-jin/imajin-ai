-- 0102_agent_knocks.sql
-- External-agent knock onboarding path (#1883), built on the #1881 Day-1
-- scope-resolution review (2026-08-30, Ryan + Jin) and composing with
-- #1882's delegation_grants (auth.delegation_grants) rather than
-- duplicating it.
--
-- Settled design ("knock, not registration"):
--   - A knock declares { publicKey, declared_target, self_description,
--     requested_capabilities[] }. declared_target MUST resolve to an
--     existing principal or the knock is rejected outright — no
--     stub-minting from knocks (graph-pollution vector).
--   - Mint on accept, not on knock: the row here holds the agent's public
--     key in escrow. No auth.identities row exists for it until the
--     declared target accepts. Decline or expiry discards the request —
--     nothing was ever created.
--   - requested_capabilities are advisory only, shown to the target as a
--     preview at accept-time. They are never auto-granted — authority is
--     born exclusively via auth.delegation_grants (#1882), strictly
--     user-push, after acceptance ("two consents, cleanly separated").
--   - Multi-tenant agents: agent_did is derived deterministically from
--     public_key, so a second knock (same keypair, different target)
--     naturally references the same prospective/eventual identity. The DID
--     is minted once, on the first accepted knock; later accepts reuse it.
--   - Fail-closed, same convention as delegation_grants: status only ever
--     moves pending -> accepted | declined. There is no background
--     "expired" transition — expires_at is a plain timestamp compared at
--     list/accept/decline time, never swept into a cached status.

CREATE TABLE IF NOT EXISTS auth.agent_knocks (
  id                      TEXT        NOT NULL PRIMARY KEY,             -- knock_{nanoid}
  public_key              TEXT        NOT NULL,                         -- Ed25519 hex, escrowed until accept
  agent_did               TEXT        NOT NULL,                         -- did:imajin derived from public_key
  declared_target         TEXT        NOT NULL,                         -- resolved DID of the existing principal
  self_description        TEXT,
  requested_capabilities  JSONB       NOT NULL DEFAULT '[]'::jsonb,      -- advisory only, never authority
  external_did            TEXT,                                         -- optional bring-your-own DID, recorded as an attestation on accept
  status                  TEXT        NOT NULL DEFAULT 'pending',       -- 'pending' | 'accepted' | 'declined'
  expires_at              TIMESTAMPTZ NOT NULL,
  responded_at            TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Target-side review surface: list pending knocks for a target.
CREATE INDEX IF NOT EXISTS idx_agent_knocks_target_status
  ON auth.agent_knocks (declared_target, status);

-- Multi-tenant reuse: has this keypair already knocked/minted anywhere?
CREATE INDEX IF NOT EXISTS idx_agent_knocks_agent_did
  ON auth.agent_knocks (agent_did);

-- Idempotent re-knock lookup: does a pending request from this keypair to
-- this target already exist? (basic abuse guard — refresh in place instead
-- of piling up duplicates).
CREATE INDEX IF NOT EXISTS idx_agent_knocks_pending_lookup
  ON auth.agent_knocks (public_key, declared_target, status);
