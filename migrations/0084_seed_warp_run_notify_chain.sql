-- 0084_seed_warp_run_notify_chain.sql
-- Route Warp run outcomes to the notify reactor so a dispatched run finishing
-- wakes the agent that dispatched it (Issue #1644).
--
-- Follows 0039/0042: scope = NULL (node default), reactors as a jsonb array.
--
-- `emit` is kept alongside `notify` deliberately. A DB row REPLACES the
-- hardcoded chain in packages/bus/src/config.ts rather than extending it, so
-- dropping `emit` here would silently take `warp.run.*` off the live event
-- stream that #1639 Stage 3 put it on.
--
-- The notify reactor sends to `event.subject`, which watchRun() sets to the
-- dispatching DID (apps/kernel/src/lib/warp/dispatch.ts) — that is what makes the
-- notification, and therefore the WebSocket push, land on the right recipient.
--
-- `{{field}}` placeholders in title/body are substituted from the event payload
-- by the notify reactor. `await: false` — a notification must never hold up the
-- rest of the chain.
--
-- Depends on:
--   #1639 Stage 3 / #1642 — warp.run.completed + warp.run.timeout are published
--   #1644              — notify → WebSocket push on notification create

-- warp.run.completed: `state` is SUCCEEDED | FAILED | CANCELLED, `title` is the
-- run's own title (may be absent, in which case the placeholder renders empty).
INSERT INTO kernel.bus_chain_configs (event_type, scope, reactors, enabled)
VALUES (
  'warp.run.completed',
  NULL,
  '[{"type":"emit","config":{},"enabled":true},{"type":"notify","config":{"title":"Warp run completed","body":"Run {{state}}: {{title}}"},"enabled":true,"await":false}]'::jsonb,
  true
)
ON CONFLICT (event_type, scope) DO UPDATE
  SET reactors = EXCLUDED.reactors,
      updated_at = now();

-- warp.run.timeout: the watch gave up, so `lastKnownState` is the most useful
-- thing to put in front of whoever dispatched the run.
INSERT INTO kernel.bus_chain_configs (event_type, scope, reactors, enabled)
VALUES (
  'warp.run.timeout',
  NULL,
  '[{"type":"emit","config":{},"enabled":true},{"type":"notify","config":{"title":"Warp run timed out","body":"Run {{runId}} last seen {{lastKnownState}}"},"enabled":true,"await":false}]'::jsonb,
  true
)
ON CONFLICT (event_type, scope) DO UPDATE
  SET reactors = EXCLUDED.reactors,
      updated_at = now();
