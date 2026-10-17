-- 0082_profile_field_predicate_invalidation.sql
-- Revoke cached broker predicate claims when a profile field changes (#1517).

INSERT INTO kernel.bus_chain_configs (event_type, scope, reactors, enabled)
VALUES (
  'profile.field.changed',
  NULL,
  '[{"type":"broker-predicate-invalidation","config":{},"await":true,"enabled":true},{"type":"emit","config":{},"enabled":true}]'::jsonb,
  true
)
ON CONFLICT (event_type, scope) DO UPDATE SET
  reactors = EXCLUDED.reactors,
  enabled = EXCLUDED.enabled;
