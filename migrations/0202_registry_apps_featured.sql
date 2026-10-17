-- #2871: directory curation is not app installation or authorization.
-- owner: kernel
ALTER TABLE registry.apps
  ADD COLUMN IF NOT EXISTS featured boolean NOT NULL DEFAULT false;
