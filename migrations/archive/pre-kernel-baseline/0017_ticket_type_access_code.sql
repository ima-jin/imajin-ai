-- Add access_code column to ticket_types for gated/hidden ticket tiers
ALTER TABLE events.ticket_types ADD COLUMN IF NOT EXISTS access_code TEXT DEFAULT NULL;
