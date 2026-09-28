-- 0166_registry_apps_nav_metadata.sql
-- owner: kernel
-- #2425 — kernel navigation derives from the app registry, not hard-coded
-- literals. `registry.apps` (#1990) had no nav metadata; this adds it as
-- plain, additive columns (no destructive SQL, per the #1981 gate's
-- guardrails):
--
--   icon           — emoji/label icon for launcher/home/auth-submenu tiles
--   entry_url      — path (or absolute URL) nav surfaces should link to
--   placements     — subset of ('launcher','home','auth-submenu') this app
--                    should render on; empty = not nav-visible yet
--   required_scope — identity scope required to see this app in nav, or
--                    NULL when any authenticated scope may see it
--
-- Backfilled for the 6 pre-seeded first-party apps that #1981 will extract
-- out of the monorepo (0139_registry_apps_seed_first_party.sql, slug'd by
-- 0163_registry_apps_slug.sql) — values mirror packages/config/src/services.ts's
-- existing icon/visibility fields for the same slugs, so nav rendering is
-- pixel-identical to today's hard-coded IdentityTabBar/services.ts values.
-- `jin` (the neutral shell) and `pay`/`media` (kernel-native, never pruned)
-- are deliberately NOT given placements here — they stay outside the
-- registry-driven nav surface this issue covers (see app-nav.ts docblock).
--
-- Guarded (`icon IS NULL OR entry_url IS NULL OR placements = '{}'`) so a
-- re-run — or an operator who has since hand-edited a row via the admin
-- registry surface — is never clobbered.
--
-- `app_first_party_dykil` deliberately kept `slug IS NULL` after
-- 0163_registry_apps_slug.sql, reserving 'dykil' for a future
-- `apps.provision({slug:'dykil',...})` third-party row (#1985/#1991
-- extraction). No such row exists yet on a fresh DB today, so leaving
-- dykil slug-less here would silently drop it out of registry-driven nav
-- — a real regression versus today's hard-coded IdentityTabBar, which
-- still links to it. This migration claims the slug for the legacy row
-- now (nav-reachable today); whoever performs the dykil extraction must
-- free it first (rename/null this row's slug before inserting the new
-- third-party row) — the exact same one-time handoff 0163's own docblock
-- already flags as a deliberate, separate cleanup step (#1991).

UPDATE registry.apps
SET slug = 'dykil'
WHERE id = 'app_first_party_dykil'
  AND slug IS NULL
  AND NOT EXISTS (SELECT 1 FROM registry.apps WHERE slug = 'dykil');

ALTER TABLE registry.apps
  ADD COLUMN IF NOT EXISTS icon TEXT;

ALTER TABLE registry.apps
  ADD COLUMN IF NOT EXISTS entry_url TEXT;

ALTER TABLE registry.apps
  ADD COLUMN IF NOT EXISTS placements TEXT[] NOT NULL DEFAULT '{}';

ALTER TABLE registry.apps
  ADD COLUMN IF NOT EXISTS required_scope TEXT;

UPDATE registry.apps
SET icon = '☕', entry_url = '/coffee', placements = ARRAY['launcher','home','auth-submenu'], required_scope = 'creator'
WHERE slug = 'coffee' AND (icon IS NULL OR entry_url IS NULL OR placements = '{}');

UPDATE registry.apps
SET icon = '📋', entry_url = '/dykil', placements = ARRAY['launcher','home','auth-submenu'], required_scope = 'creator'
WHERE slug = 'dykil' AND (icon IS NULL OR entry_url IS NULL OR placements = '{}');

UPDATE registry.apps
SET icon = '🔗', entry_url = '/links', placements = ARRAY['launcher','home','auth-submenu'], required_scope = 'creator'
WHERE slug = 'links' AND (icon IS NULL OR entry_url IS NULL OR placements = '{}');

UPDATE registry.apps
SET icon = '📚', entry_url = '/learn', placements = ARRAY['launcher','home','auth-submenu'], required_scope = NULL
WHERE slug = 'learn' AND (icon IS NULL OR entry_url IS NULL OR placements = '{}');

UPDATE registry.apps
SET icon = '🎫', entry_url = '/events', placements = ARRAY['launcher','home','auth-submenu'], required_scope = NULL
WHERE slug = 'events' AND (icon IS NULL OR entry_url IS NULL OR placements = '{}');

UPDATE registry.apps
SET icon = '🏪', entry_url = '/market', placements = ARRAY['launcher','home','auth-submenu'], required_scope = NULL
WHERE slug = 'market' AND (icon IS NULL OR entry_url IS NULL OR placements = '{}');
