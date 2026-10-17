-- 0172_attestations_ref.sql
-- owner: kernel
-- #2534: generic, optional, indexed `ref` on auth.attestations.
--
-- A free-form pointer that lets an app link an attestation to its own
-- identifier (e.g. an events `ticketId`) without a cross-schema join. Set at
-- POST /auth/api/attestations, filtered with GET ...&ref=<value>. It is a
-- lookup key only — never a general payload query surface — and rows stay
-- under the existing disclosure_scope enforcement (default 'parties').
--
-- Forward-only and additive: nullable, no default, no backfill, so every
-- existing row and writer is unaffected. Kernel-owned (auth schema); see
-- migrations/OWNERSHIP.md.
ALTER TABLE auth.attestations ADD COLUMN IF NOT EXISTS ref TEXT;

-- Partial: most attestations carry no ref, so don't index the NULLs
-- (same shape as idx_auth_attestations_context_id, migration 0171).
CREATE INDEX IF NOT EXISTS idx_auth_attestations_ref
  ON auth.attestations (ref)
  WHERE ref IS NOT NULL;
