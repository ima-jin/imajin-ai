-- owner: kernel
-- #2859 — principal-scoped signed reply delivery and notification replay.
-- Requester-only subscription entitlement remains unchanged. Neither emit nor
-- notification previews contain the private reply or its signature.
INSERT INTO kernel.bus_chain_configs (event_type, scope, reactors, enabled)
VALUES (
  'agent.reach.replied',
  NULL,
  '[{"type":"emit","config":{"fields":["reachId","principalDid","requesterDid","transcriptHash","issuedAt","state","context_id","context_type"]},"enabled":true},{"type":"notify","config":{"title":"Reach reply sent","body":"Your signed Reach reply is available"},"enabled":true}]'::jsonb,
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
      WHERE event_type = 'agent.reach.replied' AND scope IS NULL
    ),
    enabled = true,
    updated_at = now()
WHERE event_type = 'agent.reach.replied' AND scope = 'agent';
