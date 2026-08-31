-- 0107_knock_external_did_verification.sql
-- Verify external_did against its did:web document on knock (#1900) —
-- domain control is the trust anchor, same root as TLS. Today a knock's
-- optional bring-your-own `external_did` is recorded but never resolved,
-- so an accepting human sees an unverified claim ("I'm Boardy") presented
-- as fact on the accept surface.
--
-- These columns are computed once, at knock-submission time (so the
-- pending-review surface can label the claim before a human decides), and
-- carried forward unchanged into the #1883 external-identity attestation
-- minted on accept. Never swept or re-derived in the background — same
-- fail-closed, compute-once convention as agent_knocks.status and
-- delegation_grants.status elsewhere in this schema.
--
-- external_did_verification is NULL when no external_did was declared;
-- otherwise one of:
--   'verified'             - the knock's Ed25519 public key was found in
--                             the resolved did:web document's verification
--                             methods.
--   'declared_unverified'  - the claim was never checked (non-did:web
--                             method, out of scope for v1) or the resolved
--                             document did not contain the key. Never a
--                             hard rejection — labeled, not blocked.
--   'resolution_failed'    - resolving the did:web document itself failed
--                             (timeout, missing did.json, parse error).
--                             Never fatal to the knock and never silently
--                             upgraded to 'verified'.

ALTER TABLE auth.agent_knocks
  ADD COLUMN IF NOT EXISTS external_did_verification TEXT,
  ADD COLUMN IF NOT EXISTS external_did_verified_at TIMESTAMPTZ;

ALTER TABLE auth.agent_knocks
  DROP CONSTRAINT IF EXISTS chk_agent_knocks_external_did_verification;

ALTER TABLE auth.agent_knocks
  ADD CONSTRAINT chk_agent_knocks_external_did_verification
  CHECK (external_did_verification IS NULL OR external_did_verification IN ('verified', 'declared_unverified', 'resolution_failed'));
