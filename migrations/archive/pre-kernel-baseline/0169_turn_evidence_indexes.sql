-- 0169_turn_evidence_indexes.sql
-- owner: kernel
-- #1978 (epic #1758, RFC-31 v2) — `agent.turn.evidence`: tool I/O as the
-- committed boundary of an agent turn. One attestation per tool call, stored
-- in the existing auth.attestations table (no new table). This migration adds
-- only what the new type needs to be queried and kept consistent:
--
-- 1. Lookup by the turn's claim hash. `GET /auth/api/verify/turn/:hash` is an
--    unauthenticated endpoint, so its only query — "evidence rows whose
--    payload.turnOutputHash = :hash" — must be index-backed, not a scan.
--    The partial predicate matches the query's own WHERE exactly.
--
-- 2. Idempotent replay. A turn-finalization batch may be retried; a unique
--    index on (issuer, turn event id, seq) lets the ingest do
--    `ON CONFLICT DO NOTHING` so a replay never duplicates or mutates a
--    committed row. Revoked rows are intentionally still covered: a revoked
--    seq must not be silently re-issued under the same turn.
--
-- 3. Evidence count per usage row (the /jin dashboard, #1864): grouped count
--    over payload.usageRef.
--
-- 4. Discoverability: seed the type into auth.attestation_type_registry (same
--    as the intro-funnel vocabulary, 0100). Registry-gated types are subject
--    to disclosure_scope on `GET /auth/api/attestations`; evidence rows
--    default to 'parties', so the list endpoint does not publish them — the
--    public path to evidence is the verify endpoint, which returns only
--    hashes, tool names and timestamps.
--
-- All DDL is idempotent (IF NOT EXISTS / ON CONFLICT).

CREATE INDEX IF NOT EXISTS idx_auth_attestations_turn_evidence_output_hash
  ON auth.attestations ((payload->>'turnOutputHash'))
  WHERE type = 'agent.turn.evidence' AND revoked_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_auth_attestations_turn_evidence_seq
  ON auth.attestations (issuer_did, context_id, ((payload->>'seq')))
  WHERE type = 'agent.turn.evidence';

CREATE INDEX IF NOT EXISTS idx_auth_attestations_turn_evidence_usage_ref
  ON auth.attestations (subject_did, (payload->>'usageRef'))
  WHERE type = 'agent.turn.evidence' AND revoked_at IS NULL AND (payload->>'usageRef') IS NOT NULL;

INSERT INTO auth.attestation_type_registry (type_name, namespace, registered_by_did, description)
VALUES
  ('agent.turn.evidence', 'platform', NULL, 'Agent-signed commitment to one tool call within a turn: input/output hashes, tool name, observed-at, and an optional retained-output asset reference. Hashes and references only — never raw tool I/O.')
ON CONFLICT (type_name) DO NOTHING;
