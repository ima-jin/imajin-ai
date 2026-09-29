-- 0168_pay_payment_request_tax_amounts.sql
-- owner: kernel
--
-- #2421 — payment_request charges tax: subtotal / tax / total, end to end.
--
-- `total_amount` (0143) keeps its name and becomes the GRAND total the
-- payer owes: total_amount = subtotal_amount + tax_total_amount, exactly,
-- in integer minor units (per packages/money — no floats). The two new
-- columns follow 0143's `<noun>_amount integer` convention.
--
--   subtotal_amount   pre-tax line-items sum — the `.fair` tax basis
--                     (`taxes[].basisAmount`) and the platform-fee base.
--   tax_total_amount  Σ `fair_manifest.taxes[].amount`; 0 when no tax.
--
-- Backfill: every pre-existing row has subtotal = total and tax_total = 0,
-- so old requests render and settle unchanged. Idempotent: re-running only
-- touches rows still missing a subtotal, and never overwrites a row that
-- already carries tax.
--
-- ADDITIVE ONLY.

ALTER TABLE pay.payment_request
  ADD COLUMN IF NOT EXISTS subtotal_amount integer;

ALTER TABLE pay.payment_request
  ADD COLUMN IF NOT EXISTS tax_total_amount integer NOT NULL DEFAULT 0;

UPDATE pay.payment_request
   SET subtotal_amount = total_amount
 WHERE subtotal_amount IS NULL;

ALTER TABLE pay.payment_request
  ALTER COLUMN subtotal_amount SET NOT NULL;
