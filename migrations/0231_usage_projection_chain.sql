-- owner: kernel
-- #3261: DB rows override code defaults. Preserve attestation and emit exactly;
-- add the existing-table projection without changing publish await semantics.
-- Baseline constraint uniq_bus_chain_configs_event_type_scope uses
-- UNIQUE NULLS NOT DISTINCT (event_type, scope), so NULL scope conflicts too.
INSERT INTO kernel.bus_chain_configs (event_type, scope, reactors, enabled)
VALUES (
  'usage.incurred',
  NULL,
  '[{"type":"attestation","config":{"attestationType":"usage.incurred"},"enabled":true},{"type":"emit","config":{},"enabled":true},{"type":"usage-projection","config":{},"enabled":true}]'::jsonb,
  true
)
ON CONFLICT (event_type, scope) DO UPDATE
SET reactors = EXCLUDED.reactors, enabled = EXCLUDED.enabled, updated_at = now();
