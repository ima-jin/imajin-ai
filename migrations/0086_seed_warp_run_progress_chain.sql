-- 0086_seed_warp_run_progress_chain.sql
-- Route mid-run Warp progress deltas down the same chain as the terminal
-- outcomes, so a run that is still going is visible instead of silent (#1682).
--
-- Follows 0084: scope = NULL (node default), reactors as a jsonb array, `emit`
-- kept alongside `notify` because a DB row REPLACES the hardcoded chain in
-- packages/bus/src/config.ts rather than extending it.
--
-- Volume: watchRun publishes `warp.run.progress` only when something actually
-- changed since the previous poll (state transition, new conversation messages,
-- a cost movement, a status message, a new artifact). The notification count
-- therefore tracks the run's real activity, not the poll schedule.
--
-- `summary` is a scalar one-liner on the payload (e.g. `QUEUED -> INPROGRESS`,
-- `3 new messages`) so the notify reactor's flat `{{field}}` substitution can
-- render a readable body without walking `newMessages`.
--
-- Depends on:
--   #1639 Stage 3 / #1642 — the watch and its terminal events
--   #1644                 — notify -> WebSocket push on notification create
--   #1682                 — warp.run.progress itself

INSERT INTO kernel.bus_chain_configs (event_type, scope, reactors, enabled)
VALUES (
  'warp.run.progress',
  NULL,
  '[{"type":"emit","config":{},"enabled":true},{"type":"notify","config":{"title":"Warp run progress","body":"Run {{runId}}: {{summary}}"},"enabled":true,"await":false}]'::jsonb,
  true
)
ON CONFLICT (event_type, scope) DO UPDATE
  SET reactors = EXCLUDED.reactors,
      updated_at = now();
