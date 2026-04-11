-- Add imajin_did column to relay_config for node identity bootstrap (#675)
ALTER TABLE relay.relay_config ADD COLUMN IF NOT EXISTS imajin_did TEXT;
