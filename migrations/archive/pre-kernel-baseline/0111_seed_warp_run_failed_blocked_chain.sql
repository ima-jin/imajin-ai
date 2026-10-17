-- 0109_seed_warp_run_failed_blocked_chain.sql
-- Route Warp run FAILED and BLOCKED transitions to their own notify chains
-- (Issue #1838).
--
-- Follows 0084/0091/0098: scope = NULL (node default), reactors as a jsonb
-- array, `emit` kept alongside `notify` because a DB row REPLACES the
-- hardcoded chain in packages/bus/src/config.ts rather than extending it.
--
-- Problem: warp.run.completed's `state` field used to carry FAILED alongside
-- SUCCEEDED/CANCELLED, and BLOCKED was not reported at all until the watch's
-- 30-minute budget expired and reported a generic warp.run.timeout. A run sat
-- BLOCKED (missing repo access) for 40+ minutes unnoticed before this.
--
-- Fix: FAILED now publishes `warp.run.failed`, and a run entering BLOCKED
-- immediately publishes `warp.run.blocked`. Both need the same emit + notify
-- chain warp.run.completed already has.
--
-- `summary` is a flat scalar on the payload (mirrors warp.run.progress,
-- migration 0086) so the notify reactor's `{{field}}` substitution can render
-- a readable body without walking `statusMessage`.
--
-- Depends on:
--   #1639 Stage 3 / #1642 / migration 0084 — warp.run.completed + notify
--   #1644                                  — notify -> WebSocket push
--   #1838                                  — this split + BLOCKED first-class

INSERT INTO kernel.bus_chain_configs (event_type, scope, reactors, enabled)
VALUES (
  'warp.run.failed',
  NULL,
  '[{"type":"emit","config":{},"enabled":true},{"type":"notify","config":{"title":"Warp run failed","body":"Run failed: {{title}} — {{summary}}"},"enabled":true,"await":false}]'::jsonb,
  true
)
ON CONFLICT (event_type, scope) DO UPDATE
  SET reactors = EXCLUDED.reactors,
      updated_at = now();

INSERT INTO kernel.bus_chain_configs (event_type, scope, reactors, enabled)
VALUES (
  'warp.run.blocked',
  NULL,
  '[{"type":"emit","config":{},"enabled":true},{"type":"notify","config":{"title":"Warp run blocked","body":"Run blocked: {{title}} — {{summary}}"},"enabled":true,"await":false}]'::jsonb,
  true
)
ON CONFLICT (event_type, scope) DO UPDATE
  SET reactors = EXCLUDED.reactors,
      updated_at = now();
