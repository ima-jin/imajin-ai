-- Migration 0029: Change currency defaults from USD to CAD in pay schema
-- Idempotent: safe to re-run

BEGIN;

-- Update defaults for new rows
ALTER TABLE pay.balances ALTER COLUMN currency SET DEFAULT 'CAD';
ALTER TABLE pay.transactions ALTER COLUMN currency SET DEFAULT 'CAD';

-- Backfill existing dev data (no real USD balances in production yet)
UPDATE pay.balances SET currency = 'CAD' WHERE currency = 'USD';
UPDATE pay.transactions SET currency = 'CAD' WHERE currency = 'USD';

COMMIT;
