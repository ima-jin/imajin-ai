-- 0192_reach_envelopes.sql
-- owner: kernel
-- Private delivery storage only. No chat, reply handling or callback workflow.
CREATE SCHEMA IF NOT EXISTS auth;

CREATE TABLE IF NOT EXISTS auth.reach_envelopes (
  reach_id text PRIMARY KEY,
  principal_did text NOT NULL,
  requester_did text NOT NULL,
  transcript_hash text NOT NULL,
  envelope jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz
);

ALTER TABLE auth.reach_envelopes ADD COLUMN IF NOT EXISTS published_at timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS idx_reach_envelopes_replay
  ON auth.reach_envelopes (principal_did, requester_did, transcript_hash);
CREATE INDEX IF NOT EXISTS idx_reach_envelopes_principal_day
  ON auth.reach_envelopes (principal_did, created_at);
CREATE INDEX IF NOT EXISTS idx_reach_envelopes_sender_day
  ON auth.reach_envelopes (principal_did, requester_did, created_at);

CREATE TABLE IF NOT EXISTS auth.reach_sender_blocks (
  principal_did text NOT NULL,
  requester_did text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (principal_did, requester_did)
);
