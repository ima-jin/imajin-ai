-- 0109_attestation_supersedes.sql
-- Amendment-by-supersession for attestations (#1790).
--
-- A bilateral attestation (v1) can be amended by proposing a new attestation
-- (v2) that names v1 via `supersedes`. v1 stays authoritative until v2 itself
-- goes bilateral — at which point POST /auth/api/attestations/countersign
-- atomically flips v1 -> `superseded` and v2 -> `bilateral` in one
-- db.transaction() (see countersign/route.ts). v1 is never deleted or
-- hidden from direct-id lookups; it just stops being the operative record.
--
-- Deliberately a dedicated column rather than riding either existing
-- attestation-to-attestation reference mechanism:
--   - `context_id`/`context_type` is already semantically committed to the
--     revocation-pointer convention (app/api/auth/revoke/route.ts).
--   - `prev_event_ref` (migrations/0101_attestation_funnel_envelope.sql) is
--     the closest shape precedent (self-FK + partial index, same table) but
--     is deliberately side-effect-free funnel-chain plumbing — mixing
--     supersession into it risks a future funnel attestation accidentally
--     tripping supersession logic. `supersedes` follows the exact same
--     column/index pattern without sharing the column itself.
--
-- Eligibility (proposer must be issuer or subject of the referenced
-- attestation, and that attestation must be bilateral) is validated at
-- creation time and re-verified inside the countersign transaction — see
-- app/auth/api/attestations/attestation-helpers.ts — rather than enforced by
-- a DB CHECK constraint, since both checks need to read the referenced row's
-- current issuer/subject/status.
--
-- `superseded` joins the existing free-text attestation_status vocabulary
-- (pending | bilateral | declined | collecting | executed | expired | null)
-- — no CHECK/enum constraint exists to alter, same as every other status
-- value in this column.

ALTER TABLE auth.attestations
  ADD COLUMN IF NOT EXISTS supersedes text REFERENCES auth.attestations(id);

CREATE INDEX IF NOT EXISTS idx_auth_attestations_supersedes
  ON auth.attestations (supersedes)
  WHERE supersedes IS NOT NULL;
