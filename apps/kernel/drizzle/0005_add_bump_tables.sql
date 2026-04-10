-- registry.bump_sessions
CREATE TABLE IF NOT EXISTS registry.bump_sessions (
  id TEXT PRIMARY KEY,
  did TEXT NOT NULL,
  node_id TEXT NOT NULL,
  location JSONB,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  deactivated_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_bump_sessions_node_expires
  ON registry.bump_sessions (node_id, expires_at)
  WHERE deactivated_at IS NULL;

-- registry.bump_events
CREATE TABLE IF NOT EXISTS registry.bump_events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES registry.bump_sessions(id),
  waveform JSONB NOT NULL,
  rotation_rate JSONB NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL,
  location JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_bump_events_session_created
  ON registry.bump_events (session_id, created_at);

-- registry.bump_matches
CREATE TABLE IF NOT EXISTS registry.bump_matches (
  id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL,
  session_a TEXT NOT NULL REFERENCES registry.bump_sessions(id),
  session_b TEXT NOT NULL REFERENCES registry.bump_sessions(id),
  correlation_score REAL NOT NULL,
  confirmed_a BOOLEAN,
  confirmed_b BOOLEAN,
  connection_id TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_bump_matches_expires_no_connection
  ON registry.bump_matches (expires_at)
  WHERE connection_id IS NULL;
