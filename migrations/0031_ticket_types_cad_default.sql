-- Migration 0031: Change ticket_types currency default from USD to CAD
-- Idempotent: safe to re-run

BEGIN;

ALTER TABLE events.ticket_types ALTER COLUMN currency SET DEFAULT 'CAD';

-- Backfill existing dev data (all events are CAD-priced)
UPDATE events.ticket_types SET currency = 'CAD' WHERE currency = 'USD';

COMMIT;
