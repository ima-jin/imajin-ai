-- Migration: 0089_inference_confirmed_metadata
-- Adds confirmed/inferred metadata audit columns for the inference confirm
-- route (#1789).
--
-- POST /api/inference/confirm/:sessionId now accepts an optional edited
-- payload. inference.sessions.confirmed_metadata records the human's edit
-- (null when confirm was called with no body); candidate_intents keeps the
-- ORIGINAL inferred metadata untouched, so the guess-vs-approval delta stays
-- auditable. inference.attestations gets both inferred_metadata and
-- confirmed_metadata so the signed record itself carries the delta.

ALTER TABLE inference.sessions
  ADD COLUMN IF NOT EXISTS confirmed_metadata jsonb;

ALTER TABLE inference.attestations
  ADD COLUMN IF NOT EXISTS inferred_metadata jsonb;

ALTER TABLE inference.attestations
  ADD COLUMN IF NOT EXISTS confirmed_metadata jsonb;
