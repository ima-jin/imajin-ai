-- 0177_registry_apps_emittable_events.sql
-- owner: kernel
-- #2638 / #2641: the event types a registered app may emit onto the kernel bus
-- via POST /api/events.
--
--   emittable_events  JSONB array of event-type strings (e.g. ["tip.granted",
--                     "tip.sent"]). The operator-approved allowlist for this
--                     app: an event type not in this list is refused with 403.
--                     Written only by an operator path (admin registry route /
--                     apps.provision with the /jin card approval) — never by
--                     self-service registration.
--
-- Default is an empty array: an app can emit nothing until an operator says
-- otherwise. An app-emitted event can only ever run the notify and audit-log
-- reactors (see packages/bus/src/publish-app-event.ts) — never settle, mjn or
-- attestation issuance — regardless of what is in this list.

ALTER TABLE registry.apps
  ADD COLUMN IF NOT EXISTS emittable_events JSONB NOT NULL DEFAULT '[]'::jsonb;
