-- 0079_vault_grant_active_uniqueness.sql
-- Make "one active grant per tuple" actually mean *active* (#1535).
--
-- ## The bug
--
-- 0063 created:
--
--   CONSTRAINT uniq_vault_delegation_active UNIQUE (subject, granted_to, field, key_id)
--
-- The name and the schema comment both say "one ACTIVE grant per tuple", and the
-- code is written to match: supersede the existing grant, then insert a new one.
-- But the constraint is absolute — it has no status predicate — so the superseded
-- row still occupies the tuple and the insert violates it.
--
-- key_id is derived from the node's Ed25519 signing key, so it is constant for a
-- given node. It does not vary per entry or per generation. That means the tuple
-- (subject, granted_to, field, key_id) is effectively (owner, node, field), and
-- therefore a field can only ever hold ONE grant for its whole lifetime.
--
-- Consequences, all of which are live defects rather than hypotheticals:
--   - Re-sealing any v2 field a second time fails on insert.
--   - A revoked or expired grant can never be replaced, so #1535 renewal is
--     impossible.
--
-- This has not fired yet only because nothing writes v2 in production, and every
-- test to date mocks the database, so no test exercised a real UNIQUE.
--
-- ## The fix
--
-- Replace the table constraint with a partial unique index over active rows.
-- Superseded and revoked rows are history and may pile up; only one grant per
-- tuple may be active at a time, which is what the original comment intended and
-- what the code already assumes.

ALTER TABLE kernel.vault_delegation_grants
  DROP CONSTRAINT IF EXISTS uniq_vault_delegation_active;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_vault_delegation_active
  ON kernel.vault_delegation_grants (subject, granted_to, field, key_id)
  WHERE status = 'active';
