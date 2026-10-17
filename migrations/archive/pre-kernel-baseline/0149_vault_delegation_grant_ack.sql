-- 0149_vault_delegation_grant_ack.sql
-- owner: kernel
--
-- #2235: agent ack — sign that a fetched grant was *used*. Extends
-- kernel.vault_delegation_grants (#2231/#1242/#1439/#1603, migration 0148)
-- with the bookkeeping POST /api/vault/delegation/grants/{grantId}/ack needs:
--
--   last_fetched_at -- set the moment ANY successful fetch (one-time or
--                      reusable) decrypts the sealed value. This is the ack
--                      route's "was this grant actually fetched by this
--                      grantee" precondition. A column, not a query against
--                      kernel.audit_log, because the fetch route's
--                      vault.delegation.fetched publish is fire-and-forget
--                      (apps/kernel/app/api/vault/delegation/grants/[grantId]/fetch/route.ts
--                      never awaits it) — an ack racing immediately behind
--                      its own fetch could read a not-yet-written audit row.
--                      Setting the column synchronously inside
--                      fetchGrantSecret itself removes that race entirely.
--   acked_at         -- set the moment the grantee successfully acks.
--   ack_outcome      -- 'used' | 'failed' | 'discarded', enforced by CHECK.
--   ack_evidence     -- optional { kind?, ref?, note? } jsonb the grantee
--                      attaches (e.g. { kind: 'gha-runner', ref:
--                      'imajin-gx10', note: 'registered gx10 ok' }). The
--                      route body's separate `evidence: { kind, ref }` and
--                      `note` fields both fold into this one column rather
--                      than adding a fourth for `note` alone. Never the
--                      secret value — the route layer bounds note (≤280) and
--                      evidence.ref (≤120) length and never logs them.
--
-- Deliberately NOT part of the owner-signed canonical grant payload (see
-- apps/kernel/src/db/schemas/vault.ts docblock on purpose/oneTime/consumedAt)
-- — same reasoning as migration 0148: adding a key to that canonical form
-- would break ownerSignature verification for every grant signed before
-- this migration.
--
-- Also seeds the kernel.bus_chain_configs row for the new
-- vault.delegation.acked audit event the ack route publishes on every
-- attempt (success or refusal) — kept in sync with the packages/bus/src/
-- config.ts DEFAULTS entry, following the reconcile convention established
-- by migration 0098.
--
-- ADDITIVE ONLY.

ALTER TABLE kernel.vault_delegation_grants
  ADD COLUMN IF NOT EXISTS last_fetched_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS acked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ack_outcome TEXT,
  ADD COLUMN IF NOT EXISTS ack_evidence JSONB;

ALTER TABLE kernel.vault_delegation_grants
  ADD CONSTRAINT chk_vault_delegation_grants_ack_outcome
  CHECK (ack_outcome IS NULL OR ack_outcome IN ('used', 'failed', 'discarded'));

INSERT INTO kernel.bus_chain_configs (event_type, scope, reactors, enabled)
VALUES (
  'vault.delegation.acked',
  NULL,
  '[{"type":"audit-log","config":{"fields":["grantId","granteeDid","ownerDid","purpose","outcome","evidenceKind","ackedAt"]},"enabled":true}]'::jsonb,
  true
)
ON CONFLICT (event_type, scope) DO UPDATE
  SET reactors = EXCLUDED.reactors,
      updated_at = now();
