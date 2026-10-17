-- 0063_bus_supply_lots.sql
-- Supply-chain lot + stage spine for @imajin/bus (Issue #1136).
--
-- Materializes a lot and its ordered stages, threaded by correlationId, so a
-- supply chain (declared -> collected -> processed -> listed -> settled) is
-- queryable as one ordered history. Depends on the supply.* event types (#1134).
--
-- Generic by design: no commodity-specific columns. Per-stage detail lives in
-- supply_stages.payload (jsonb) + the stage's attestation; this pair is the
-- reusable spine for any input -> transform -> sale chain.

CREATE SCHEMA IF NOT EXISTS kernel;

CREATE TABLE IF NOT EXISTS kernel.supply_lots (
  correlation_id  TEXT PRIMARY KEY,
  originating_did TEXT NOT NULL,
  commodity       TEXT,
  status          TEXT NOT NULL DEFAULT 'open',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS kernel.supply_stages (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  correlation_id  TEXT NOT NULL REFERENCES kernel.supply_lots (correlation_id),
  stage           TEXT NOT NULL,
  actor_did       TEXT NOT NULL,
  attestation_cid TEXT,
  prior_cid       TEXT,
  payload         JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_supply_stages_correlation_created
  ON kernel.supply_stages (correlation_id, created_at);
