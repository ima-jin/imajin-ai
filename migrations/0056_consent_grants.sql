-- 0056_consent_grants.sql
-- Consent grant store for the broker pipeline (Issue #1049).
--
-- Turns the consent reactor from hardcoded fail-closed defaults into a
-- DB-backed lookup. Each row is a grant from a `subject` to a `granted_to`
-- DID (or `*` wildcard) for a `purpose`, releasing `allowed_fields`.
--
-- `granted_to_class` is included now (NULL by default) so reach-ring class
-- grants (#1189) can extend this table without a schema migration.

CREATE TABLE IF NOT EXISTS kernel.consent_grants (
  id               TEXT PRIMARY KEY,
  subject          TEXT NOT NULL,
  granted_to       TEXT,               -- specific DID or '*'; NULL when granted_to_class is set
  granted_to_class TEXT,               -- 'connections' | 'one_degree' | 'strangers' (future: #1189)
  purpose          TEXT NOT NULL,
  allowed_fields   TEXT[] NOT NULL,
  mode             TEXT NOT NULL DEFAULT 'attestation',
  status           TEXT NOT NULL DEFAULT 'active',
  consent_ref      TEXT NOT NULL,      -- stable reference ID for audit trail
  expires_at       TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_consent_grants_subject ON kernel.consent_grants (subject);

CREATE INDEX IF NOT EXISTS idx_consent_grants_lookup ON kernel.consent_grants (subject, granted_to, purpose)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_consent_grants_expires ON kernel.consent_grants (expires_at)
  WHERE expires_at IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Broker publish events — consent lifecycle (emit-only)
-- ---------------------------------------------------------------------------
-- broker.consent.created / broker.consent.revoked: downstream notification of
-- consent changes. Emit-only — no attestation/settle ceremony in Phase 1.
INSERT INTO kernel.bus_chain_configs (event_type, scope, reactors, enabled)
VALUES (
  'broker.consent.created',
  NULL,
  '[{"type":"emit","config":{},"enabled":true}]'::jsonb,
  true
)
ON CONFLICT (event_type, scope) DO NOTHING;

INSERT INTO kernel.bus_chain_configs (event_type, scope, reactors, enabled)
VALUES (
  'broker.consent.revoked',
  NULL,
  '[{"type":"emit","config":{},"enabled":true}]'::jsonb,
  true
)
ON CONFLICT (event_type, scope) DO NOTHING;
