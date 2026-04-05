-- Forest config — per-group service toggles and landing page
CREATE TABLE IF NOT EXISTS auth.forest_config (
  group_did        TEXT PRIMARY KEY,
  enabled_services TEXT[] NOT NULL DEFAULT '{}',
  landing_service  TEXT,
  theme            JSONB NOT NULL DEFAULT '{}',
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);
