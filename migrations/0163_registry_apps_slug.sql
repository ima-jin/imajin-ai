-- 0163_registry_apps_slug.sql
-- owner: kernel
-- apps.provision (#2375): a short, URL/repo-safe slug identifying an app
-- independent of its registry.apps `id` (app_<nanoid>) or `app_did`. This is
-- the idempotency key `apps.provision` looks up by — reusing registry.apps
-- (#1990) rather than a parallel table, per that issue's own precedent.
--
-- Backfilled for the 7 pre-seeded first-party rows (0139_registry_apps_seed_
-- first_party.sql) from their existing `token_audiences[1]`, which already
-- carries the same short scope id ('coffee', 'dykil', 'links', ...) this
-- column now makes a first-class, uniquely-indexed field instead of an
-- array-position convention.

ALTER TABLE registry.apps
  ADD COLUMN IF NOT EXISTS slug TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_registry_apps_slug ON registry.apps (slug) WHERE slug IS NOT NULL;

UPDATE registry.apps
SET slug = token_audiences[1]
WHERE slug IS NULL
  AND tier = 'first_party'
  AND cardinality(token_audiences) = 1
  AND id IN (
    'app_first_party_coffee',
    'app_first_party_dykil',
    'app_first_party_links',
    'app_first_party_learn',
    'app_first_party_events',
    'app_first_party_market',
    'app_first_party_jin'
  );
