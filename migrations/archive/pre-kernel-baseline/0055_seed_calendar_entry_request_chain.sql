-- 0054_seed_calendar_entry_request_chain.sql
-- Seed the broker chain config for calendar.entry.request (Issue #1188, #241).
--
-- calendar.entry.request is the broker event type used by
-- GET /calendar/api/d/[did]/entries to gate non-public calendar entries
-- through the consent → scope → release → audit pipeline.
--
-- Mirrors calendar.availability.request (seeded in 0042). The connections-level
-- consent grants that make this pipeline actually release data land in #1049 + #1189.
-- Until then, the broker fail-closes for all connections-visibility entries.

INSERT INTO kernel.bus_chain_configs (event_type, scope, reactors, enabled)
VALUES (
  'calendar.entry.request',
  NULL,
  '[{"type":"consent","config":{},"enabled":true},{"type":"scope","config":{},"enabled":true},{"type":"release","config":{},"enabled":true},{"type":"audit","config":{},"enabled":true}]'::jsonb,
  true
)
ON CONFLICT (event_type, scope) DO NOTHING;
