-- 0100_attestation_funnel_envelope.sql
-- Envelope fields for the intro-funnel schema (#1885): { subject, actor,
-- delegator?, timestamp, disclosure_scope, prev_event_ref }.
--
-- subject/actor/timestamp already exist as subject_did/issuer_did/issued_at
-- — no column needed. This migration adds the three genuinely new fields
-- directly to auth.attestations (not a parallel table), so any existing or
-- future attestation type can opt into them:
--
--   delegator_did   — optional DID that authorized the actor to sign this
--                      attestation on its behalf (mirrors the existing
--                      actingFor/composedBy delegation concept).
--   disclosure_scope — closed four-value enum, default 'parties'. Extending
--                      the enum is deliberately a schema change (Day-1
--                      review). Enforcement lives in application code
--                      (GET /auth/api/attestations) and is scoped to types
--                      present in auth.attestation_type_registry, so the
--                      ~59 pre-existing hardcoded types keep today's
--                      unrestricted query behavior.
--   prev_event_ref   — nullable self-reference to the immediate predecessor
--                      attestation's id (not its cid, which is best-effort
--                      and nullable). Makes a funnel a verifiable chain;
--                      see packages/auth/src/intro-funnel.ts for the
--                      per-type expected-predecessor mapping.
--
-- Consent correlation (two independent consent_given/consent_declined
-- records fanning in to one intro_proposed) deliberately reuses the
-- existing context_id/context_type columns as a correlation ID rather than
-- a new FK column — the same generic mechanism every other context-bearing
-- attestation type already uses.

ALTER TABLE auth.attestations
  ADD COLUMN IF NOT EXISTS delegator_did text,
  ADD COLUMN IF NOT EXISTS disclosure_scope text NOT NULL DEFAULT 'parties',
  ADD COLUMN IF NOT EXISTS prev_event_ref text REFERENCES auth.attestations(id);

ALTER TABLE auth.attestations
  DROP CONSTRAINT IF EXISTS chk_auth_attestations_disclosure_scope;

ALTER TABLE auth.attestations
  ADD CONSTRAINT chk_auth_attestations_disclosure_scope
  CHECK (disclosure_scope IN ('parties', 'connections', 'network', 'public'));

CREATE INDEX IF NOT EXISTS idx_auth_attestations_prev_event_ref
  ON auth.attestations (prev_event_ref)
  WHERE prev_event_ref IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_auth_attestations_disclosure_scope
  ON auth.attestations (disclosure_scope);
