-- 0100_attestation_type_registry.sql
-- Attestation-type registry as DATA, not hardcoded per-service (#1885).
--
-- Problem: `packages/auth/src/types/attestation.ts` ATTESTATION_TYPES is a
-- compile-time-only const array. That works fine for platform types shipped
-- in a release, but doesn't scale to third-party matchmaking/scheduling
-- agents that want to mint their own attestation vocabulary without a PR to
-- this repo.
--
-- Fix: a kernel-owned registry table. Platform-seeded rows (namespace =
-- 'platform', registered_by_did IS NULL) ship the intro-funnel vocabulary
-- here. Third parties register new types under their own namespace via
-- POST /auth/api/attestations/types (gated on requireEstablishedDID, #1885).
--
-- This is additive: the existing hardcoded ATTESTATION_TYPES array is left
-- untouched and keeps validating the ~59 pre-existing types with zero DB
-- hits. Type validation in the attestation-creation routes becomes
-- `ATTESTATION_TYPES.includes(type) || isRegisteredAttestationType(type)` —
-- this table is the extension surface, not a replacement.

CREATE TABLE IF NOT EXISTS auth.attestation_type_registry (
  type_name         text PRIMARY KEY,
  namespace         text NOT NULL DEFAULT 'platform',
  registered_by_did text,                 -- NULL for platform-seeded entries
  description       text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  revoked_at        timestamptz
);

CREATE INDEX IF NOT EXISTS idx_attestation_type_registry_namespace
  ON auth.attestation_type_registry (namespace);

-- Platform-seeded intro-funnel vocabulary (#1885 Day-1 review). All five
-- types are also present in ATTESTATION_TYPES for TS-level type safety;
-- registering them here makes them discoverable via
-- GET /auth/api/attestations/types alongside third-party namespaced types.
INSERT INTO auth.attestation_type_registry (type_name, namespace, registered_by_did, description)
VALUES
  ('intro_proposed', 'platform', NULL, 'Agent proposes an intro between two parties. Genesis event of an intro funnel.'),
  ('consent_given', 'platform', NULL, 'A human independently consents to a proposed intro. Correlates to intro_proposed via context_id.'),
  ('consent_declined', 'platform', NULL, 'A human independently declines a proposed intro. First-class — required for acceptance-rate denominators.'),
  ('intro_made', 'platform', NULL, 'Agent makes the intro after both parties have consented.'),
  ('conversation_happened', 'platform', NULL, 'Either party signs that the conversation happened. Evidence-graded via the existing countersign/decline flow: unilateral / corroborated / disputed.')
ON CONFLICT (type_name) DO NOTHING;
