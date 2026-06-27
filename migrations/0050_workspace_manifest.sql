-- #1123: Workspace manifest tables (Layer 2)
-- workspace_snapshots: content-addressed manifest of a DID's asset state at a point in time
-- workspace_branches:  mutable HEAD pointer per named branch per DID
-- workspace_history_grants: workspace-wide history access grants

CREATE TABLE IF NOT EXISTS media.workspace_snapshots (
  id               TEXT PRIMARY KEY,
  owner_did        TEXT NOT NULL,
  branch_name      TEXT NOT NULL DEFAULT 'main',
  manifest_cid     TEXT NOT NULL,
  manifest         JSONB NOT NULL,
  parent_snapshot_id TEXT REFERENCES media.workspace_snapshots(id),
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_workspace_snapshots_owner
  ON media.workspace_snapshots (owner_did);
CREATE INDEX IF NOT EXISTS idx_workspace_snapshots_branch
  ON media.workspace_snapshots (owner_did, branch_name);

CREATE TABLE IF NOT EXISTS media.workspace_branches (
  id               TEXT PRIMARY KEY,
  owner_did        TEXT NOT NULL,
  branch_name      TEXT NOT NULL,
  head_snapshot_id TEXT REFERENCES media.workspace_snapshots(id),
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT uq_workspace_branch UNIQUE (owner_did, branch_name)
);

CREATE INDEX IF NOT EXISTS idx_workspace_branches_owner
  ON media.workspace_branches (owner_did);

CREATE TABLE IF NOT EXISTS media.workspace_history_grants (
  id           TEXT PRIMARY KEY,
  owner_did    TEXT NOT NULL,
  grantee_did  TEXT NOT NULL,
  scope        TEXT NOT NULL DEFAULT 'broad',
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT uq_workspace_history_grant UNIQUE (owner_did, grantee_did)
);

CREATE INDEX IF NOT EXISTS idx_workspace_history_grants_owner
  ON media.workspace_history_grants (owner_did);
