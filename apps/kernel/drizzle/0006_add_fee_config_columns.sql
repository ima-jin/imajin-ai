-- Add fee configuration columns for fee model v3
-- Node operator fee rates on relay_config
ALTER TABLE relay.relay_config ADD COLUMN IF NOT EXISTS node_fee_bps INTEGER DEFAULT 50;
ALTER TABLE relay.relay_config ADD COLUMN IF NOT EXISTS buyer_credit_bps INTEGER DEFAULT 25;
ALTER TABLE relay.relay_config ADD COLUMN IF NOT EXISTS node_operator_did TEXT;

-- Scope fee on forest_config
ALTER TABLE profile.forest_config ADD COLUMN IF NOT EXISTS scope_fee_bps INTEGER DEFAULT 25;
