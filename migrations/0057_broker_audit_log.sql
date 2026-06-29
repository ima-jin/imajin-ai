-- 0057_broker_audit_log.sql
-- Persistent audit log for every broker release and rejection (Issue #1050).
--
-- The audit reactor already fires broker.release / broker.rejection bus events,
-- but those are ephemeral. This table provides a queryable, append-only record
-- so subjects can inspect who accessed their data and when, and operators can
-- verify consent enforcement.

CREATE TABLE IF NOT EXISTS kernel.broker_audit_log (
  id               TEXT PRIMARY KEY,
  type             TEXT NOT NULL,       -- 'release' | 'rejection'
  requester        TEXT NOT NULL,
  subject          TEXT NOT NULL,
  purpose          TEXT NOT NULL,
  scope            TEXT NOT NULL,
  fields_requested TEXT[] NOT NULL,
  fields_released  TEXT[],             -- NULL for rejections
  status           TEXT NOT NULL,       -- 'RELEASED' | 'DENIED'
  mode             TEXT,               -- 'attestation' | 'raw' — NULL for rejections
  consent_ref      TEXT,
  reason           TEXT,               -- rejection reason — NULL for releases
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_broker_audit_subject
  ON kernel.broker_audit_log (subject, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_broker_audit_requester
  ON kernel.broker_audit_log (requester, created_at DESC);
