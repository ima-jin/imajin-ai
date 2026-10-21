-- 0176_registry_apps_provides_scopes_depends_on.sql
-- owner: kernel
-- #2663: a registered app can declare its own scopes, and one token can satisfy
-- both the app and the services it fronts.
--
-- Extends the existing app scope-assignment model (registry.apps.requested_scopes,
-- #244) rather than adding a parallel mechanism:
--
--   provides_scopes  scope strings the app defines and enforces itself
--                    (e.g. dykil:read, dykil:write). POST /auth/api/tokens/app
--                    grants these on a token minted for this app's audience, on
--                    top of the platform SCOPE_VOCABULARY. Validated at write
--                    time: not already in the vocabulary, not in a
--                    vocabulary-owned namespace, in the app's slug namespace
--                    when it has one.
--
--   depends_on       [{ "aud": "<registered host>", "scopes": ["media:read", ...] }]
--                    other registered audiences a token minted for this app must
--                    also carry, so the same token is accepted by those services
--                    (e.g. the kernel media routes). An audience that is no
--                    longer registered and active is dropped at mint time.
--
-- Both default to an empty array, so existing rows behave exactly as before.

ALTER TABLE registry.apps
  ADD COLUMN IF NOT EXISTS provides_scopes JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE registry.apps
  ADD COLUMN IF NOT EXISTS depends_on JSONB NOT NULL DEFAULT '[]'::jsonb;
