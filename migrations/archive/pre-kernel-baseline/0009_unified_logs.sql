-- Unified logs table: replaces request_log + app_logs
-- Source: 'request' (withLogger HTTP requests) or 'app' (application-level logs)

CREATE TABLE IF NOT EXISTS registry.logs (
  id             TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  source         TEXT NOT NULL DEFAULT 'request',  -- 'request' | 'app'
  service        TEXT NOT NULL,
  level          TEXT NOT NULL DEFAULT 'info',      -- 'error' | 'warn' | 'info' | 'debug'
  message        TEXT,
  method         TEXT,
  path           TEXT,
  status         INTEGER,
  duration_ms    INTEGER,
  did            TEXT,
  ip             TEXT,
  correlation_id TEXT,
  error_message  TEXT,
  metadata       JSONB,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Primary query pattern: recent logs by service
CREATE INDEX IF NOT EXISTS idx_logs_service_created
  ON registry.logs (service, created_at DESC);

-- Error filtering (the main use case Ryan wants)
CREATE INDEX IF NOT EXISTS idx_logs_errors
  ON registry.logs (created_at DESC) WHERE level IN ('error', 'warn');

-- Cross-service tracing
CREATE INDEX IF NOT EXISTS idx_logs_correlation
  ON registry.logs (correlation_id) WHERE correlation_id IS NOT NULL;

-- Source filtering
CREATE INDEX IF NOT EXISTS idx_logs_source
  ON registry.logs (source, created_at DESC);

-- Migrate existing data
INSERT INTO registry.logs (id, source, service, level, message, method, path, status, duration_ms, did, ip, correlation_id, error_message, created_at)
  SELECT id, 'request', service,
    CASE WHEN status >= 500 THEN 'error' WHEN status >= 400 THEN 'warn' ELSE 'info' END,
    COALESCE(error_message, method || ' ' || path || ' → ' || status),
    method, path, status, duration_ms, did, ip, correlation_id, error_message, created_at
  FROM registry.request_log
  ON CONFLICT (id) DO NOTHING;

INSERT INTO registry.logs (id, source, service, level, message, method, path, did, correlation_id, metadata, created_at)
  SELECT id, 'app', service, level, message, method, path, did, correlation_id, metadata, created_at
  FROM registry.app_logs
  ON CONFLICT (id) DO NOTHING;
