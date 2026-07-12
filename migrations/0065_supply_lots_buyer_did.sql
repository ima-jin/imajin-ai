-- 0065_supply_lots_buyer_did.sql
-- #1210: record the buyer's DID on the lot at invoice creation so settlement can
-- set order.completed.buyerDid (from_did + buyer_credit recipient). Additive +
-- idempotent.

ALTER TABLE kernel.supply_lots ADD COLUMN IF NOT EXISTS buyer_did TEXT;
