-- 0059_seed_document_changed_project_chain.sql
-- Attach the release-gated projection reactor (Issue #1207, EPIC #1204) to the
-- document.changed bus chain.
--
-- #1205 (migration 0058) seeded document.changed emit-only. This migration
-- appends the `project` reactor so editing a tracked authored document runs the
-- broker consent→scope→release→audit decision per field (#1206 release policy)
-- and materializes ONLY released fields into their existing projection home
-- (Q2: no generic projection table). `await: true` so the projection is settled
-- before the media write path returns, matching the vault-hot-reload precedent.
--
-- Kept in lockstep with the hardcoded DEFAULTS fallback in
-- packages/bus/src/config.ts. Idempotent UPSERT so a fresh DB (no 0058 row) and
-- an existing DB converge to the same chain.

INSERT INTO kernel.bus_chain_configs (event_type, scope, reactors, enabled)
VALUES (
  'document.changed',
  NULL,
  '[{"type":"emit","config":{},"enabled":true},{"type":"project","config":{},"await":true,"enabled":true}]'::jsonb,
  true
)
ON CONFLICT (event_type, scope) DO UPDATE
  SET reactors = EXCLUDED.reactors,
      enabled = EXCLUDED.enabled;
