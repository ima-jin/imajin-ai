-- 0064_supply_lots_fair_manifest.sql
-- #1210: persist the .fair manifest (the revenue split) on the lot at invoice
-- creation, so settlement can execute it when the invoice is paid. Additive +
-- idempotent.

ALTER TABLE kernel.supply_lots ADD COLUMN IF NOT EXISTS fair_manifest JSONB;
