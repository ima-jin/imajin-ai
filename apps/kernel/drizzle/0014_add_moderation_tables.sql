CREATE TABLE IF NOT EXISTS registry.flags (
  id TEXT PRIMARY KEY,
  reporter_did TEXT NOT NULL,
  target_did TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  resolved_by TEXT,
  resolution TEXT
);

CREATE TABLE IF NOT EXISTS registry.moderation_log (
  id TEXT PRIMARY KEY,
  operator_did TEXT NOT NULL,
  action TEXT NOT NULL,
  target_did TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  reason TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
