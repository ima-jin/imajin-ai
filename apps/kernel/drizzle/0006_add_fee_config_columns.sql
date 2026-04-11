-- Add fee configuration columns for fee model v3
-- Node operator fee rates on relay_config
ALTER TABLE relay.relay_config ADD COLUMN IF NOT EXISTS node_fee_bps INTEGER DEFAULT 50;
ALTER TABLE relay.relay_config ADD COLUMN IF NOT EXISTS buyer_credit_bps INTEGER DEFAULT 25;
ALTER TABLE relay.relay_config ADD COLUMN IF NOT EXISTS node_operator_did TEXT;

-- Create forest_config if it doesn't exist (table was in drizzle schema but had no CREATE TABLE migration)
CREATE TABLE IF NOT EXISTS profile.forest_config (
  group_did TEXT PRIMARY KEY,
  enabled_services TEXT[] NOT NULL DEFAULT '{}'::text[],
  landing_service TEXT,
  theme JSONB DEFAULT '{}'::jsonb,
  scope_fee_bps INTEGER DEFAULT 25,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Scope fee column (idempotent — covers envs where table pre-existed without this column)
ALTER TABLE profile.forest_config ADD COLUMN IF NOT EXISTS scope_fee_bps INTEGER DEFAULT 25;
