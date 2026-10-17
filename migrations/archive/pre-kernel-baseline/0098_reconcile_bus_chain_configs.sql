-- 0098_reconcile_bus_chain_configs.sql
-- Systematic reconciliation: fix NULL-scope duplicate rows, tighten the unique
-- constraint, and bring all divergent bus_chain_configs rows in line with the
-- hardcoded DEFAULTS in packages/bus/src/config.ts (Issues #1873, #1874).
--
-- Problem: migration 0039 seeded multiple rows that later drifted from code
-- DEFAULTS. Because getChainConfig() queries the DB first and only falls back
-- to DEFAULTS when no row exists, the stale DB rows silently shadow intended
-- behaviour. Additionally, PostgreSQL treats NULL != NULL in unique
-- constraints, so ON CONFLICT (event_type, scope) never fires for scope=NULL,
-- allowing duplicate rows (e.g. attestation.created after migration 0096).
--
-- Fix:
-- 1. Deduplicate: for each event_type with scope IS NULL, keep only the row
--    with the latest updated_at.
-- 2. Alter the unique constraint to NULLS NOT DISTINCT (PG15+) so future
--    upserts for NULL scope behave correctly.
-- 3. Upsert every row that diverges from DEFAULTS so DB and code converge.
--
-- Depends on:
--   #763  / migration 0039 — original seed
--   #1856 / migration 0096 — attestation.created partial fix (created duplicate)
--   #1869                  — NULL-scope duplicate row cleanup
--   #1873, #1874           — this migration

-- ---------------------------------------------------------------------------
-- 1. Deduplicate NULL-scope rows: keep only the newest per event_type
-- ---------------------------------------------------------------------------

DELETE FROM kernel.bus_chain_configs
WHERE id IN (
  SELECT id
  FROM (
    SELECT id,
           ROW_NUMBER() OVER (
             PARTITION BY event_type
             ORDER BY updated_at DESC, created_at DESC, id DESC
           ) AS rn
    FROM kernel.bus_chain_configs
    WHERE scope IS NULL
  ) sub
  WHERE rn > 1
);

-- ---------------------------------------------------------------------------
-- 2. Tighten unique constraint so NULL scope participates in uniqueness
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  constraint_name TEXT;
BEGIN
  SELECT tc.constraint_name INTO constraint_name
  FROM information_schema.table_constraints tc
  WHERE tc.table_schema = 'kernel'
    AND tc.table_name = 'bus_chain_configs'
    AND tc.constraint_type = 'UNIQUE'
    AND tc.constraint_name LIKE '%event_type%scope%';

  IF constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE kernel.bus_chain_configs DROP CONSTRAINT %I', constraint_name);
  END IF;
END $$;

ALTER TABLE kernel.bus_chain_configs
ADD CONSTRAINT uniq_bus_chain_configs_event_type_scope
UNIQUE NULLS NOT DISTINCT (event_type, scope);

-- ---------------------------------------------------------------------------
-- 3. Reconcile divergent rows to match current DEFAULTS
-- ---------------------------------------------------------------------------

-- order.completed: add supply-recorder before settle (#1375, #1873)
-- Kept in sync with packages/bus/src/config.ts DEFAULTS['order.completed'].
INSERT INTO kernel.bus_chain_configs (event_type, scope, reactors, enabled)
VALUES (
  'order.completed',
  NULL,
  '[{"type":"supply-recorder","config":{},"await":true,"enabled":true},{"type":"settle","config":{},"await":true,"enabled":true}]'::jsonb,
  true
)
ON CONFLICT (event_type, scope) DO UPDATE
  SET reactors = EXCLUDED.reactors,
      updated_at = now();

-- availability.match.surfaced: add notify-match-delivery after emit (#1102, #1874)
-- Kept in sync with packages/bus/src/config.ts DEFAULTS['availability.match.surfaced'].
INSERT INTO kernel.bus_chain_configs (event_type, scope, reactors, enabled)
VALUES (
  'availability.match.surfaced',
  NULL,
  '[{"type":"emit","config":{},"enabled":true},{"type":"notify-match-delivery","config":{},"enabled":true}]'::jsonb,
  true
)
ON CONFLICT (event_type, scope) DO UPDATE
  SET reactors = EXCLUDED.reactors,
      updated_at = now();

-- attestation.created: ensure emit + attestation-notify (#1820, #1856, #1869, #1874)
-- Kept in sync with packages/bus/src/config.ts DEFAULTS['attestation.created'].
-- Migration 0096 attempted this upsert but created a duplicate row because
-- the unique constraint did not treat NULL as distinct; that is now fixed.
INSERT INTO kernel.bus_chain_configs (event_type, scope, reactors, enabled)
VALUES (
  'attestation.created',
  NULL,
  '[{"type":"emit","config":{},"enabled":true},{"type":"attestation-notify","config":{},"enabled":true}]'::jsonb,
  true
)
ON CONFLICT (event_type, scope) DO UPDATE
  SET reactors = EXCLUDED.reactors,
      updated_at = now();
