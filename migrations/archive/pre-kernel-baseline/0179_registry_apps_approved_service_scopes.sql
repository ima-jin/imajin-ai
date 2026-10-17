-- 0179_registry_apps_approved_service_scopes.sql
-- owner: kernel
-- #2711: operator-approved, per-app service scopes.
--
-- #1803 fenced a session-less service token (POST /auth/api/apps/token/service)
-- to requestedScopes ∩ serviceEligibleScopes(). That fence is global and
-- fail-closed; it cannot express "this one app may carry identity:write".
-- These columns hold the set of scopes the OPERATOR has approved for one app,
-- written only by the countersigned `apps:service-scopes` approval on /jin
-- (src/lib/apps/service-scopes.ts). The mint becomes
--   requestedScopes ∩ (serviceEligibleScopes() ∪ approved_service_scopes)
-- so an app can never self-grant a service scope through requested_scopes.
--
--   approved_service_scopes      scope strings the operator approved (default none)
--   service_scopes_approval_id   operator.approvals proposal id of the last change
--   service_scopes_approved_at   when that countersigned decision was made
--
-- The full decision (who signed, over which hash) lives on operator.approvals.

ALTER TABLE registry.apps
  ADD COLUMN IF NOT EXISTS approved_service_scopes JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE registry.apps
  ADD COLUMN IF NOT EXISTS service_scopes_approval_id TEXT;

ALTER TABLE registry.apps
  ADD COLUMN IF NOT EXISTS service_scopes_approved_at TIMESTAMPTZ;
