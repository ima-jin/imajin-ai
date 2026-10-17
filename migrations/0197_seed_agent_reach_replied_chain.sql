-- owner: kernel
-- #2589 — reply content/signature is private to the committed requester.
-- No notify, harness, attestation, or callback: emit metadata only.
INSERT INTO kernel.bus_chain_configs (event_type, scope, reactors, enabled)
VALUES (
  'agent.reach.replied',
  NULL,
  '[{"type":"emit","config":{"fields":["reachId","principalDid","requesterDid","transcriptHash","issuedAt","state","context_id","context_type"]},"enabled":true}]'::jsonb,
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
