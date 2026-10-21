-- 0218_connection_requested_notify_chain.sql
-- owner: kernel
-- #3013: direct requests already persist one connection.invited attestation.
-- Match DEFAULTS['connection.requested']; delivery only, no attestation reactor.
-- 0217 is reserved by #3001. The NULLS NOT DISTINCT constraint from 0098
-- makes replay update the same node-default row rather than duplicate it.
INSERT INTO kernel.bus_chain_configs (event_type, scope, reactors, enabled)
VALUES (
  'connection.requested',
  NULL,
  '[{"type":"notify","config":{"scope":"connection:request-received"},"enabled":true}]'::jsonb,
  true
)
ON CONFLICT (event_type, scope) DO UPDATE
SET reactors = EXCLUDED.reactors, enabled = EXCLUDED.enabled, updated_at = now();
