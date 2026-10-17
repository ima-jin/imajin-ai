-- #2871: directory curation is not app installation or authorization.
ALTER TABLE registry.apps
  ADD COLUMN IF NOT EXISTS featured boolean NOT NULL DEFAULT false;
