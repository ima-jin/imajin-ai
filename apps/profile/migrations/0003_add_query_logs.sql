CREATE TABLE IF NOT EXISTS profile.query_logs (
  id TEXT PRIMARY KEY,
  requester_did TEXT NOT NULL,
  target_did TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd NUMERIC(10,6) NOT NULL DEFAULT 0,
  settled BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_query_logs_requester ON profile.query_logs(requester_did);
CREATE INDEX IF NOT EXISTS idx_query_logs_target ON profile.query_logs(target_did);
