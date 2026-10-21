-- 0093_claimable_stub_primitive.sql
-- Phase 1 of #1834 (unified claimable-stub primitive): email-keyed dedup
-- index backing "mint on new email" for connections invites.
--
-- Keyed by a salted/peppered HMAC-SHA256 of the normalised email (see
-- apps/kernel/src/lib/auth/claimable-stub.ts), never the plaintext, so a
-- second introduction of the same email can be matched and silently
-- accrued to the same `auth.identities` stub row without ever disclosing
-- whether the email already existed in the system (ratified design pt. 2
-- on #1834 — "match-without-disclosure").
--
-- `email_encrypted` holds the email AES-256-GCM-encrypted at rest with a
-- key derived from the same server-held secret as the HMAC (see PR
-- description for the delivery-vs-storage tradeoff discussion) — needed so
-- the reminder ladder (catalyst-power/xprize#75) can re-send later without
-- re-collecting the email from the introducer. No plaintext email is ever
-- stored in this table.
--
-- `claimant_verified_at` is one half of the ratcheted bilateral claim
-- (ratified design pt. 3): set when the claimant proves ownership of the
-- email. The other half — the inviter-side countersign — is read from
-- `connections.invites` (an accepted invite whose `to_did` is this stub's
-- DID) rather than duplicated here.

CREATE TABLE IF NOT EXISTS auth.claim_stub_index (
  email_hmac           text        PRIMARY KEY,
  did                  text        NOT NULL UNIQUE REFERENCES auth.identities(id),
  email_encrypted      text        NOT NULL,
  claimant_verified_at timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_claim_stub_index_did ON auth.claim_stub_index (did);
