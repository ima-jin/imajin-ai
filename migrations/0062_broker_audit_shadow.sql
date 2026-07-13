-- 0061_broker_audit_shadow.sql
-- Shadow-mode flag for the broker audit trail (Issue #1231).
--
-- Shadow mode runs the full consent → scope → release → audit pipeline and
-- writes a real audit row, but the decision is advisory (non-binding) for the
-- caller. This column distinguishes shadow decisions from enforced ones so
-- post-PoC analysis can answer "what WOULD have been denied" via
-- GET /api/broker/audit?shadow=true.
--
-- Existing rows predate shadow mode and are enforced decisions → default false.

ALTER TABLE kernel.broker_audit_log
  ADD COLUMN IF NOT EXISTS shadow BOOLEAN NOT NULL DEFAULT false;
