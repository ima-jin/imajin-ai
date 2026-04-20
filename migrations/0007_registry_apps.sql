-- 0007_registry_apps.sql
-- Registered third-party apps for delegated session access (Issue #244)

CREATE TABLE IF NOT EXISTS registry.apps (
  id               TEXT PRIMARY KEY,
  owner_did        TEXT NOT NULL,
  name             TEXT NOT NULL,
  description      TEXT,
  app_did          TEXT NOT NULL UNIQUE,
  public_key       TEXT NOT NULL,
  private_key      TEXT NOT NULL,
  callback_url     TEXT NOT NULL,
  homepage_url     TEXT,
  logo_url         TEXT,
  requested_scopes JSONB NOT NULL DEFAULT '[]',
  status           TEXT NOT NULL DEFAULT 'active',
  revoked_at       TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_registry_apps_owner  ON registry.apps (owner_did);
CREATE INDEX IF NOT EXISTS idx_registry_apps_status ON registry.apps (status);
