-- 0203_registry_apps_featured.sql — #2871: curation is not installation or authorization.
-- owner: kernel
ALTER TABLE registry.apps
  ADD COLUMN IF NOT EXISTS featured boolean NOT NULL DEFAULT false;
