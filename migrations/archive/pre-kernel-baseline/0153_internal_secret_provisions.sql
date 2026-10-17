-- 0153_internal_secret_provisions.sql
-- owner: kernel
--
-- #2245: self-provisioned internal secrets — first target
-- FOREIGN_PRINCIPAL_STUB_SECRET (kernel-internal, single consumer, ahead of
-- ATTESTATION_INTERNAL_API_KEY per the #2245 issue ruling, 2026-09-22).
--
-- Ruling: an internal generated secret doesn't need a human to exist, only
-- to be replaced or destroyed. On first boot the kernel looks up a
-- static-secret grant for a given purpose bound to its OWN node DID
-- (self-granted via the pre-existing #1439/#2231 sealAndGrantStaticSecret
-- path); if none exists yet, it generates one in-process, seals + grants
-- it to itself, and emits exactly one mechanical `vault.secret.generated`
-- attestation binding only the purpose/grantId/contentHash — never the
-- bytes. See apps/kernel/src/lib/vault/internal-secret.ts.
--
--   owner_did  -- the node's own DID (subject === granted_to on the
--                 resulting vault_delegation_grants row)
--   purpose    -- free-form label, e.g. 'kernel.foreign-principal-pepper'
--   field      -- vault field the sealed secret lives at
--   grant_id   -- vault_delegation_grants.id, set once sealing completes
--
-- This table holds NO secret material — it exists purely so a UNIQUE
-- constraint on (owner_did, purpose) gives two boots racing to provision
-- the same purpose a single DB-enforced winner; the loser polls
-- vault_delegation_grants for the winner's now-active grant instead of
-- generating a second, different secret. See that module's docblock for
-- the full concurrency contract.
--
-- Also seeds the `kernel.bus_chain_configs` row for the new
-- `vault.secret.generated` audit event the generate path publishes —
-- kept in sync with the packages/bus/src/config.ts DEFAULTS entry,
-- following the reconcile convention established by migration 0098.
--
-- ADDITIVE ONLY.

CREATE TABLE IF NOT EXISTS kernel.internal_secret_provisions (
  id TEXT PRIMARY KEY,
  owner_did TEXT NOT NULL,
  purpose TEXT NOT NULL,
  field TEXT NOT NULL,
  grant_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_internal_secret_provisions_owner_purpose
  ON kernel.internal_secret_provisions (owner_did, purpose);

INSERT INTO kernel.bus_chain_configs (event_type, scope, reactors, enabled)
VALUES (
  'vault.secret.generated',
  NULL,
  '[{"type":"audit-log","config":{"fields":["purpose","grantId","contentHash"]},"enabled":true}]'::jsonb,
  true
)
ON CONFLICT (event_type, scope) DO UPDATE
  SET reactors = EXCLUDED.reactors,
      updated_at = now();
