-- Migration: Add missing columns to events schema
-- currency on events.events + status on events.orders were in the drizzle
-- schema but never migrated.

ALTER TABLE events.events ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'CAD';

ALTER TABLE events.orders ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending';
CREATE INDEX IF NOT EXISTS idx_orders_status ON events.orders(status);
