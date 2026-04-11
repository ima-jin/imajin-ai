CREATE TABLE IF NOT EXISTS registry.system_events (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  service TEXT NOT NULL,
  action TEXT NOT NULL,
  did TEXT,
  correlation_id TEXT,
  parent_event_id TEXT,
  payload JSONB,
  status TEXT DEFAULT 'success',
  duration_ms INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_system_events_service_action ON registry.system_events(service, action);
CREATE INDEX idx_system_events_correlation ON registry.system_events(correlation_id);
CREATE INDEX idx_system_events_did ON registry.system_events(did);
CREATE INDEX idx_system_events_created ON registry.system_events(created_at DESC);
