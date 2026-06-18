-- 0042_seed_calendar_chain_configs.sql
-- Seed reactor chain configs for calendar primitive + broker availability pipeline (Issue #1098).
-- Follows the pattern of 0039_seed_bus_chain_configs.sql — scope = NULL (node defaults).
--
-- Depends on:
--   #1103 — broker() config-driven (calendar.availability.request broker chain takes effect)
--   #241  — calendar primitive (defines the calendar.entry.* event types)
--   #1099 — availability intent (defines calendar.availability.request)

-- ---------------------------------------------------------------------------
-- Calendar mutations (via bus.publish())
-- ---------------------------------------------------------------------------
-- calendar.entry.created: signed attestation record + emit for downstream.
-- The attestation creates an auditable on-chain record that an entry was created
-- without leaking any intent data — the entry itself stays sealed.
INSERT INTO kernel.bus_chain_configs (event_type, scope, reactors, enabled)
VALUES (
  'calendar.entry.created',
  NULL,
  '[{"type":"attestation","config":{"attestationType":"calendar.entry.created"},"enabled":true},{"type":"emit","config":{},"enabled":true}]'::jsonb,
  true
)
ON CONFLICT (event_type, scope) DO NOTHING;

-- calendar.entry.updated: lightweight — no attestation on edits, just emit.
INSERT INTO kernel.bus_chain_configs (event_type, scope, reactors, enabled)
VALUES (
  'calendar.entry.updated',
  NULL,
  '[{"type":"emit","config":{},"enabled":true}]'::jsonb,
  true
)
ON CONFLICT (event_type, scope) DO NOTHING;

-- calendar.entry.deleted: cleanup signal.
INSERT INTO kernel.bus_chain_configs (event_type, scope, reactors, enabled)
VALUES (
  'calendar.entry.deleted',
  NULL,
  '[{"type":"emit","config":{},"enabled":true}]'::jsonb,
  true
)
ON CONFLICT (event_type, scope) DO NOTHING;

-- calendar.entry.expired: TTL cleanup signal — no attestation needed.
INSERT INTO kernel.bus_chain_configs (event_type, scope, reactors, enabled)
VALUES (
  'calendar.entry.expired',
  NULL,
  '[{"type":"emit","config":{},"enabled":true}]'::jsonb,
  true
)
ON CONFLICT (event_type, scope) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Broker pipeline chain — calendar availability request
-- (broker() reads this via getBrokerChainConfig() after #1103)
-- ---------------------------------------------------------------------------
-- calendar.availability.request: explicit consent → scope → release → audit chain.
-- This is the broker pipeline config (resolved by getBrokerChainConfig, not publish).
-- Sealed by default: no consent config exists for arbitrary requesters, so the
-- broker fail-closes. Reach-ring consent wired in #1049; double-blind in #1102.
INSERT INTO kernel.bus_chain_configs (event_type, scope, reactors, enabled)
VALUES (
  'calendar.availability.request',
  NULL,
  '[{"type":"consent","config":{},"enabled":true},{"type":"scope","config":{},"enabled":true},{"type":"release","config":{},"enabled":true},{"type":"audit","config":{},"enabled":true}]'::jsonb,
  true
)
ON CONFLICT (event_type, scope) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Broker publish events — upgrade broker.release to include attestation + settle
-- ---------------------------------------------------------------------------
-- broker.release: upgrade from the emit-only row seeded in 0039.
-- attestation: signed record of the release (who got what, when, under what consent).
-- settle:      requester pays the query fee via the .fair manifest on the release event.
-- emit:        downstream notification for subscribers.
--
-- Uses DO UPDATE to intentionally override the 0039 emit-only default.
-- Scoped overrides (e.g. Tripian disabling settle during testing) can be added
-- per-scope without touching this node default.
INSERT INTO kernel.bus_chain_configs (event_type, scope, reactors, enabled)
VALUES (
  'broker.release',
  NULL,
  '[{"type":"attestation","config":{"attestationType":"broker.release"},"enabled":true},{"type":"settle","config":{},"await":true,"enabled":true},{"type":"emit","config":{},"enabled":true}]'::jsonb,
  true
)
ON CONFLICT (event_type, scope) DO UPDATE
  SET reactors = EXCLUDED.reactors,
      updated_at = now();

-- broker.rejection: already emit-only in 0039 — no change needed.
-- Included here as an explicit no-op for documentation clarity.
INSERT INTO kernel.bus_chain_configs (event_type, scope, reactors, enabled)
VALUES (
  'broker.rejection',
  NULL,
  '[{"type":"emit","config":{},"enabled":true}]'::jsonb,
  true
)
ON CONFLICT (event_type, scope) DO NOTHING;
