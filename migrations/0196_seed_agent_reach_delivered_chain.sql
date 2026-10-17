-- owner: kernel
-- #2588 — delivery service owns persistence and the single attestation.
-- The chain only emits and notifies; never duplicate the attestation here.
-- Emit metadata only; private envelope content stays in principal-scoped notify.
-- Keep both node default and any existing agent-scope override in sync with
-- packages/bus/src/config.ts. An agent override otherwise shadows the default.
INSERT INTO kernel.bus_chain_configs (event_type, scope, reactors, enabled)
VALUES (
  'agent.reach.delivered',
  NULL,
  '[{"type":"emit","config":{"fields":["reachId","principalDid","requesterDid","topic","requesterTier","transcriptHash","issuedAt"]},"enabled":true},{"type":"notify","config":{"title":"New Reach message","body":"Reach message about {{topic}} from {{requesterDid}}"},"enabled":true}]'::jsonb,
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
      WHERE event_type = 'agent.reach.delivered' AND scope IS NULL
    ),
    enabled = true,
    updated_at = now()
WHERE event_type = 'agent.reach.delivered' AND scope = 'agent';
