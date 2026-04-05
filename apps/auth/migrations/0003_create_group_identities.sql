-- Phase 1: Group identities — scoped multi-controller DIDs
CREATE TABLE IF NOT EXISTS auth.group_identities (
  group_did   TEXT PRIMARY KEY,
  scope       TEXT NOT NULL,           -- 'org' | 'community' | 'family'
  created_by  TEXT NOT NULL,           -- DID of creator
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Phase 2: Group controllers — who controls each group DID
CREATE TABLE IF NOT EXISTS auth.group_controllers (
  group_did       TEXT NOT NULL,
  controller_did  TEXT NOT NULL,
  role            TEXT NOT NULL DEFAULT 'member',  -- 'owner' | 'admin' | 'member'
  added_by        TEXT,
  added_at        TIMESTAMPTZ DEFAULT NOW(),
  removed_at      TIMESTAMPTZ,                     -- soft delete
  PRIMARY KEY (group_did, controller_did)
);

CREATE INDEX IF NOT EXISTS idx_group_controllers_controller ON auth.group_controllers (controller_did);
