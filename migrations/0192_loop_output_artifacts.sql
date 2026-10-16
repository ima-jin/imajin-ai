-- owner: kernel
-- #2406: private, content-addressed, redacted loop output.
CREATE TABLE IF NOT EXISTS kernel.loop_output_artifacts (
  id TEXT PRIMARY KEY,
  loop_id TEXT NOT NULL,
  principal TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  byte_length INTEGER NOT NULL CHECK (byte_length > 0),
  media_type TEXT NOT NULL DEFAULT 'application/json' CHECK (media_type = 'application/json'),
  content JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_loop_output_artifacts_scope_hash
  ON kernel.loop_output_artifacts (principal, loop_id, sha256);
