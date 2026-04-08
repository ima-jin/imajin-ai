CREATE TABLE IF NOT EXISTS auth.group_identities (
  group_did TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS auth.group_controllers (
  group_did TEXT NOT NULL,
  controller_did TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  allowed_services TEXT[],
  added_by TEXT,
  added_at TIMESTAMPTZ DEFAULT NOW(),
  removed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_group_controllers_pk ON auth.group_controllers (group_did, controller_did);
CREATE INDEX IF NOT EXISTS idx_group_controllers_controller ON auth.group_controllers (controller_did);
