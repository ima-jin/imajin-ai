-- owner: kernel
-- #2599 — await the disclosure-safe throttling audit write.
-- No IPs, limiter keys/hashes, message bodies, or signatures are persisted.
INSERT INTO kernel.bus_chain_configs (event_type, scope, reactors, enabled)
VALUES (
  'agent.reach.throttled',
  NULL,
  '[{"type":"audit-log","config":{"fields":["principalDid","requesterDid","dimension","tier","retryAfter","context_id","context_type"]},"await":true,"enabled":true}]'::jsonb,
  true
)
ON CONFLICT (event_type, scope) DO UPDATE
  SET reactors = EXCLUDED.reactors,
      enabled = EXCLUDED.enabled,
      updated_at = now();

UPDATE kernel.bus_chain_configs
SET reactors = (
      SELECT reactors
      FROM kernel.bus_chain_configs
      WHERE event_type = 'agent.reach.throttled' AND scope IS NULL
    ),
    enabled = true,
    updated_at = now()
WHERE event_type = 'agent.reach.throttled' AND scope = 'agent';
