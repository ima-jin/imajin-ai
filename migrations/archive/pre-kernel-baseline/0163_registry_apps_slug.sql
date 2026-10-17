-- 0163_registry_apps_slug.sql
-- owner: kernel
-- apps.provision (#2375): a short, URL/repo-safe slug identifying an app
-- independent of its registry.apps `id` (app_<nanoid>) or `app_did`. This is
-- the idempotency key `apps.provision` looks up by — reusing registry.apps
-- (#1990) rather than a parallel table, per that issue's own precedent.
--
-- Backfilled for 6 of the 7 pre-seeded first-party rows
-- (0139_registry_apps_seed_first_party.sql) from their existing
-- `token_audiences[1]`, which already carries the same short scope id
-- ('coffee', 'links', ...) this column now makes a first-class,
-- uniquely-indexed field instead of an array-position convention.
--
-- `app_first_party_dykil` is deliberately EXCLUDED: dykil is mid-extraction
-- into its own standalone repo (#1985/#1991), and apps.provision registers
-- an extracted app as a NEW, separate `tier = 'third_party'` row (its own
-- id + app_did) rather than converting the legacy first-party row in place
-- (imajin-app-template's own AGENTS.md: "every app forked from this
-- template, including Imajin's own extractions (dykil, links, ...),
-- registers the same way, at the same [third_party] tier"). Since `slug` is
-- globally unique, the legacy `app_first_party_dykil` row must keep
-- `slug IS NULL` so `apps.provision({slug: 'dykil', ...})` can claim it for
-- the new row without a uniqueness conflict. The two rows coexist during
-- the split — see docs/REGISTRATION.md's "legacy vs. provisioned" note; the
-- legacy row's own eventual retirement is a separate, deliberate cleanup
-- step (#1991), out of scope here.

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
    'app_first_party_links',
    'app_first_party_learn',
    'app_first_party_events',
    'app_first_party_market',
    'app_first_party_jin'
  );
