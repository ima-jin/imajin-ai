-- 0090_warp_run_progress_telemetry_class.sql
-- Reclassify warp.run.progress as telemetry-class: notifications only fire on
-- state transitions, not on every mid-run tick (#1805).
--
-- Problem: migration 0086 routed warp.run.progress through notify alongside
-- emit. watchRun() (apps/kernel/src/lib/warp/dispatch.ts) publishes a progress
-- event on every poll that sees a change (message count, cost, status), so a
-- parallel dispatch session produced 99+ notification rows of pure operational
-- exhaust — none of it a state transition a human needs to see.
--
-- Fix: drop the `notify` reactor from this chain's row, keep `emit`. The
-- signed event stream (packages/emit -> registry.system_events, indexed on
-- `did`) is unaffected, so progress/cost ticks stay queryable per-DID for the
-- #1799 connector telemetry rollup. warp.run.completed and warp.run.timeout
-- (migration 0084) are untouched — those ARE state transitions and keep notify.
--
-- Idempotent and safe to re-run: the UPDATE only rewrites the reactors/enabled
-- columns of the existing (event_type, scope) row; a fresh INSERT covers the
-- case where 0086 never ran on this database (e.g. a clean bootstrap).
--
-- Kept in sync with packages/bus/src/config.ts DEFAULTS['warp.run.progress'].
-- A DB row in `kernel.bus_chain_configs` REPLACES that hardcoded list, which is
-- why this migration repeats `emit` rather than only removing `notify`.
--
-- Depends on:
--   #1682 / migration 0086 — warp.run.progress seeded with emit + notify
--   #1805                  — this reclassification

INSERT INTO kernel.bus_chain_configs (event_type, scope, reactors, enabled)
VALUES (
  'warp.run.progress',
  NULL,
  '[{"type":"emit","config":{},"enabled":true}]'::jsonb,
  true
)
ON CONFLICT (event_type, scope) DO UPDATE
  SET reactors = EXCLUDED.reactors,
      enabled = EXCLUDED.enabled,
      updated_at = now();
