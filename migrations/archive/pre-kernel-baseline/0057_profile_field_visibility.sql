-- 0057_profile_field_visibility.sql
-- Per-field visibility controls for profile metadata (Issue #1003).
-- First concrete consumer of the broker pipeline: proves it releases real data.
--
-- Depends on:
--   #1103 — broker() config-driven (profile.field.request broker chain takes effect)
--   #1049 — consent grants (required for 'connections'-level fields to ever release)

-- ---------------------------------------------------------------------------
-- Profile field visibility column
-- ---------------------------------------------------------------------------
-- Shape: { fieldName: { level: 'public' | 'connections' | 'selective' | 'private', allowedDids?: string[] } }
-- Default '{}' means every metadata field is treated as public (no rule = pass through).
ALTER TABLE profile.profiles
  ADD COLUMN IF NOT EXISTS field_visibility JSONB NOT NULL DEFAULT '{}';

-- ---------------------------------------------------------------------------
-- Broker pipeline chain — profile field request
-- (broker() reads this via getBrokerChainConfig() after #1103)
-- ---------------------------------------------------------------------------
-- profile.field.request: explicit consent → scope → release → audit chain.
-- This is the broker pipeline config (resolved by getBrokerChainConfig, not publish).
-- Sealed by default: no consent config exists for arbitrary requesters, so the
-- broker fail-closes and 'connections'-level fields stay sealed until #1049
-- consent grants admit the requester. Every request is audited.
INSERT INTO kernel.bus_chain_configs (event_type, scope, reactors, enabled)
VALUES (
  'profile.field.request',
  NULL,
  '[{"type":"consent","config":{},"enabled":true},{"type":"scope","config":{},"enabled":true},{"type":"release","config":{},"enabled":true},{"type":"audit","config":{},"enabled":true}]'::jsonb,
  true
)
ON CONFLICT (event_type, scope) DO NOTHING;
