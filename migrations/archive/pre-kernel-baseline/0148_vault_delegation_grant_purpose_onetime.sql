-- 0148_vault_delegation_grant_purpose_onetime.sql
-- owner: kernel
--
-- #2231: remote human -> agent credential handoff. Extends
-- kernel.vault_delegation_grants with the metadata an agent-facing fetch
-- endpoint needs, on top of the existing owner<->node delegation grant
-- machinery (#1242/#1439/#1603):
--
--   purpose     -- free-form label (e.g. 'gha-runner-registration') so a
--                  grantee can enumerate its own grants by intent without
--                  ever selecting wrapped key material.
--   one_time    -- single-use grants: the agent-fetch route consumes the
--                  grant on its first successful read.
--   consumed_at -- set the moment a one_time grant is fetched; a second
--                  fetch sees this populated and is refused with 410 Gone.
--
-- Deliberately NOT part of the owner-signed canonical grant payload (see
-- apps/kernel/src/db/schemas/vault.ts docblock on these columns) -- adding a
-- key to that canonical form would break `ownerSignature` verification for
-- every grant signed before this migration.
--
-- Also seeds the `kernel.bus_chain_configs` row for the new
-- `vault.delegation.fetched` audit event the fetch route publishes on every
-- attempt (success or refusal) -- kept in sync with the packages/bus/src/
-- config.ts DEFAULTS entry, following the reconcile convention established
-- by migration 0098.
--
-- ADDITIVE ONLY.

ALTER TABLE kernel.vault_delegation_grants
  ADD COLUMN IF NOT EXISTS purpose TEXT,
  ADD COLUMN IF NOT EXISTS one_time BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS consumed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_vault_delegation_granted_to_purpose
  ON kernel.vault_delegation_grants (granted_to, purpose);

INSERT INTO kernel.bus_chain_configs (event_type, scope, reactors, enabled)
VALUES (
  'vault.delegation.fetched',
  NULL,
  '[{"type":"audit-log","config":{"fields":["grantId","field","granteeDid","purpose","oneTime","outcome"]},"enabled":true}]'::jsonb,
  true
)
ON CONFLICT (event_type, scope) DO UPDATE
  SET reactors = EXCLUDED.reactors,
      updated_at = now();
