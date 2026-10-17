-- 0077_audit_log.sql
-- Generic, vertical-agnostic durable audit trail (Issue #1140).
--
-- Closes gap #3 of the honest-record promise (#1427): the bus already *emits*
-- events, but nothing wrote a durable, queryable record. The `audit-log` reactor
-- (packages/bus/src/reactors/audit-log.ts) writes one row here per fire when any
-- bus_chain_configs.reactors[] lists { type: 'audit-log' }.
--
-- Append-only. No replay logic (later bolt-on — capturing the record is what
-- enables it). payload is projected per the reactor config to avoid logging
-- sensitive envelope contents wholesale.

CREATE TABLE IF NOT EXISTS kernel.audit_log (
  id             TEXT PRIMARY KEY,
  event_type     TEXT NOT NULL,
  scope          TEXT NOT NULL,
  issuer         TEXT NOT NULL,
  subject        TEXT NOT NULL,
  correlation_id TEXT,                                  -- trace across reactors; nullable
  payload        JSONB,                                 -- projected per reactor config; nullable
  reactor_config JSONB,                                 -- the reactor config used, for provenance
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_log_subject
  ON kernel.audit_log (subject, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_log_correlation
  ON kernel.audit_log (correlation_id);

CREATE INDEX IF NOT EXISTS idx_audit_log_event_type
  ON kernel.audit_log (event_type, created_at DESC);
