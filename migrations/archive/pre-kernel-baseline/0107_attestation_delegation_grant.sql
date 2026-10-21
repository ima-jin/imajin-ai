-- 0107_attestation_delegation_grant.sql
-- Verified delegation grant backing a delegated attestation (#1895, #1897).
--
-- Root cause: POST /auth/api/attestations and
-- /auth/api/attestations/internal accepted payload.delegator_did as a
-- shape-only, self-asserted claim — nothing verified that delegator_did had
-- actually granted issuer_did the capability being exercised. A revoked (or
-- never-granted) agent could still mint a valid-looking "delegated"
-- attestation.
--
-- The write path now verifies, at write time, that a live (unexpired,
-- unrevoked) delegation_grants row exists from delegator_did to issuer_did
-- covering the relevant capability, and rejects the write otherwise. This
-- column records the grant it verified against, so the record stays
-- auditable — which grant backed this delegated fact, not just that some
-- grant existed at the time.

ALTER TABLE auth.attestations
  ADD COLUMN IF NOT EXISTS delegation_grant_id text REFERENCES auth.delegation_grants(id);

CREATE INDEX IF NOT EXISTS idx_auth_attestations_delegation_grant
  ON auth.attestations (delegation_grant_id)
  WHERE delegation_grant_id IS NOT NULL;
