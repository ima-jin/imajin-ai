CREATE TABLE IF NOT EXISTS registry.app_logs (
  id text PRIMARY KEY,
  service text NOT NULL,
  level text NOT NULL,
  message text NOT NULL,
  correlation_id text,
  did text,
  method text,
  path text,
  metadata jsonb,
  created_at timestamptz DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_app_logs_created ON registry.app_logs (created_at);
CREATE INDEX IF NOT EXISTS idx_app_logs_service_level ON registry.app_logs (service, level);
CREATE INDEX IF NOT EXISTS idx_app_logs_correlation ON registry.app_logs (correlation_id) WHERE correlation_id IS NOT NULL;

-- Retention: auto-delete logs older than 14 days
-- Run via pg_cron or the admin cleanup endpoint at POST /api/admin/logs/cleanup
-- CREATE EXTENSION IF NOT EXISTS pg_cron;
-- SELECT cron.schedule('app-logs-cleanup', '0 3 * * *', $$DELETE FROM registry.app_logs WHERE created_at < now() - interval '14 days'$$);
