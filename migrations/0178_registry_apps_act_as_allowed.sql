-- 0178_registry_apps_act_as_allowed.sql
-- owner: kernel
-- #2639 / #2644: operator approval, per app, for a scoped app token to carry an
-- act-as (group DID) claim.
--
--   act_as_allowed  true  = the operator approved this app to receive tokens that
--                           act as a group DID. POST /auth/api/tokens/app checks
--                           the user's group authority ONCE at mint (the existing
--                           validateActingAs gate) and only for apps with this
--                           flag set; token verification honours the claim only
--                           while the flag is still set.
--                   false = (default) act-as is refused at mint for this app.
--
-- Defaults to false, so every existing and newly registered app is "off" until an
-- operator flips it (POST /api/admin/registry/apps/:appId/act-as).

ALTER TABLE registry.apps
  ADD COLUMN IF NOT EXISTS act_as_allowed BOOLEAN NOT NULL DEFAULT false;
