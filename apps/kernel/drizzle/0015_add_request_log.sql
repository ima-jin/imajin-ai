CREATE TABLE IF NOT EXISTS registry.request_log (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  service TEXT NOT NULL,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  status INTEGER NOT NULL,
  duration_ms INTEGER,
  did TEXT,
  ip TEXT,
  correlation_id TEXT,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_request_log_service_created ON registry.request_log(service, created_at DESC);
CREATE INDEX idx_request_log_correlation ON registry.request_log(correlation_id);
CREATE INDEX idx_request_log_status ON registry.request_log(status) WHERE status >= 400;
