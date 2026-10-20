-- #2897: app discovery is independent of public web/API serving.
-- owner: kernel
ALTER TABLE registry.apps
  ADD COLUMN visibility text NOT NULL DEFAULT 'public'
  CONSTRAINT registry_apps_visibility_check
    CHECK (visibility IN ('public', 'unlisted', 'private', 'internal'));

-- Existing first-party and extracted app listings stay public. The API-only
-- services from #2869 must never acquire a navigation tile.
UPDATE registry.apps SET visibility = 'internal'
WHERE slug IN ('usage', 'calendar', 'workspace', 'google')
   OR id IN ('app_first_party_usage', 'app_first_party_calendar',
             'app_first_party_workspace', 'app_first_party_google');

-- Ryan's 2026-10-17 ruling: Artifact is private for now, by backfill, not an
-- operator follow-up. Membership is resolved live; no installs are copied.
UPDATE registry.apps SET visibility = 'private'
WHERE slug = 'artifact' OR id = 'app_first_party_artifact';
