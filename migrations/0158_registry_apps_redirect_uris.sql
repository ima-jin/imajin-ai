-- 0158_registry_apps_redirect_uris.sql
-- owner: kernel
-- #1348 OAuth DCR: store + match the full registered redirect_uri set.
--
-- registry.apps previously stored only ONE redirect URI (`callback_url`,
-- populated from `redirect_uris[0]` at DCR registration time, #1185) even
-- though RFC 7591 lets a client register several — e.g. MCP Inspector
-- registers both `/oauth/callback` and `/oauth/callback/debug`. A client
-- that authorized with any redirect_uri OTHER than the first one it
-- registered was rejected by /oauth/authorize's exact-match gate.
-- #1346/#1347 shipped narrow interim fixes (loopback path-any matching,
-- same-origin-loopback matching); #1990 (0138_registry_apps_registry_fields.sql)
-- added `allowed_redirect_hosts`, an ORIGIN-level allowlist — broader than
-- RFC 7591 intends, since it accepts any path on a registered origin, not
-- just a registered URI. This migration is the proper fix: store the full,
-- exact set of DCR-validated redirect_uris so the authorize/token use-time
-- gate can match an incoming redirect_uri by exact SET membership instead.
--
-- Additive only. `callback_url` is left in place (still the first-registered
-- URI, kept for readers that only need a single display URL) and is
-- backfilled into `redirect_uris` for every existing row so no
-- already-registered client loses its ability to authorize.

ALTER TABLE registry.apps
  ADD COLUMN IF NOT EXISTS redirect_uris TEXT[] NOT NULL DEFAULT '{}';

UPDATE registry.apps
  SET redirect_uris = ARRAY[callback_url]
  WHERE redirect_uris = '{}'::text[]
    AND callback_url IS NOT NULL
    AND callback_url <> '';
