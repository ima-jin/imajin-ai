-- 0208_seed_vault_key_imported_chain.sql
-- owner: kernel
-- #2260: persist the metadata-only imported-credential audit chain.
-- Kept in sync with packages/bus/src/config.ts DEFAULTS['vault.key.imported'].
-- DB-first lookup must not depend on the hardcoded fallback. Preserve any
-- existing operator-configured chain, including a deliberately disabled row.

INSERT INTO kernel.bus_chain_configs (event_type, scope, reactors, enabled)
VALUES (
  'vault.key.imported',
  NULL,
  '[{"type":"audit-log","config":{"fields":["field","ownerDid","consumerDid","purpose","fingerprint","grantId","authorizedBy","replacesField"]},"enabled":true}]'::jsonb,
  true
)
ON CONFLICT (event_type, scope) DO NOTHING;
