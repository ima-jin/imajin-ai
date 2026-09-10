-- Migration: 0132_operator_approvals_generic_source
-- Generalizes operator.approvals (#2059, migration 0130) to an open
-- source/kind vocabulary (#2152): kernel witnesses approvals from any
-- source, not just the OpenClaw system-agent.
--
-- Additive only, per migrations/OWNERSHIP.md (kernel owns the `operator`
-- schema):
--   source       — open vocabulary namespace, e.g. 'system-agent',
--                  'skill-workshop'. Defaults existing rows (and any
--                  legacy bare-kind ingest) to 'system-agent', the only
--                  source that existed before #2152.
--   detail       — optional, bounded (<=16KB, enforced at the notify
--                  ingest boundary, not here) per-source structured
--                  payload, e.g. skill-workshop's diff summary.
--   content_hash — sha256 hex digest covering
--                  {proposal_id, source, kind, summary, keys_touched, detail},
--                  when supplied by the source. Nullable: a legacy
--                  bare-kind request predates this concept and is not
--                  required to send one.
--
-- `kind` itself is unchanged (still `text`) — #2152 widens its meaning
-- from a fixed 3-value enum to a namespaced "<source>:<subkind>" string,
-- enforced at the application layer (see
-- apps/kernel/src/lib/notify/operator-approvals.ts), not the database.

ALTER TABLE operator.approvals
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'system-agent',
  ADD COLUMN IF NOT EXISTS detail jsonb,
  ADD COLUMN IF NOT EXISTS content_hash text;

CREATE INDEX IF NOT EXISTS idx_operator_approvals_source
  ON operator.approvals (source, status);
