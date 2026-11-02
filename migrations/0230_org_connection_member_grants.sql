-- owner: kernel
-- Authority metadata only; never stores or releases credential material (#3180).
CREATE TABLE IF NOT EXISTS kernel.org_connection_member_grants (
  id text PRIMARY KEY,
  org_did text NOT NULL,
  member_did text NOT NULL,
  connection_id text NOT NULL,
  provider text NOT NULL,
  granted_by_did text NOT NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  revoked_by_did text,
  revocation_reason text
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_org_connection_member_grant_active
  ON kernel.org_connection_member_grants (org_did, member_did, connection_id)
  WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_org_connection_member_grants_member
  ON kernel.org_connection_member_grants (org_did, member_did);
