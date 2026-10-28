-- owner: kernel
-- Retain member custody; only org-tagged invocation authority changes (#3167).
ALTER TABLE kernel.connectors ADD COLUMN IF NOT EXISTS org_suspended_at timestamptz;
CREATE TABLE IF NOT EXISTS kernel.org_connection_suspensions (
  org_did text NOT NULL,
  member_did text NOT NULL DEFAULT '',
  provider text NOT NULL,
  slot text NOT NULL DEFAULT '',
  suspended_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_org_connection_suspension
  ON kernel.org_connection_suspensions (org_did, member_did, provider, slot);
CREATE TABLE IF NOT EXISTS kernel.org_connection_events (
  id text PRIMARY KEY,
  org_did text NOT NULL,
  member_did text,
  connection_id text,
  provider text NOT NULL,
  actor_did text NOT NULL,
  action text NOT NULL,
  reason text NOT NULL,
  attestation_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_org_connection_events_org
  ON kernel.org_connection_events (org_did, created_at);
