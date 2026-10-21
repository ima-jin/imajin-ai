-- owner: kernel
-- Declaration only: never changes profile membership, forest services, or grants.
ALTER TABLE registry.apps ADD COLUMN IF NOT EXISTS profile_widget jsonb;

-- Preserve the existing specialized widgets for already registered apps.
UPDATE registry.apps
SET profile_widget = '{"path":"/profile","label":"Events","icon":"🎟"}'::jsonb
WHERE slug = 'events' AND profile_widget IS NULL;
UPDATE registry.apps
SET profile_widget = '{"path":"/profile","label":"Market","icon":"🛍"}'::jsonb
WHERE slug = 'market' AND profile_widget IS NULL;
