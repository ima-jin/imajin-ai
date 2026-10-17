-- 0037_bus_chain_configs.sql
-- DB-backed chain configs for @imajin/bus (Issue #762)

CREATE SCHEMA IF NOT EXISTS kernel;

CREATE TABLE IF NOT EXISTS kernel.bus_chain_configs (
  id         TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  event_type TEXT NOT NULL,
  scope      TEXT,
  reactors   JSONB NOT NULL,
  enabled    BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (event_type, scope)
);

CREATE INDEX IF NOT EXISTS idx_bus_chain_configs_event_type
  ON kernel.bus_chain_configs (event_type);

CREATE INDEX IF NOT EXISTS idx_bus_chain_configs_scope
  ON kernel.bus_chain_configs (scope)
  WHERE scope IS NOT NULL;
