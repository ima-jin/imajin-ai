-- 0134_pay_balance_units_drop_legacy_columns.sql
-- owner: kernel
--
-- #2016: DESTRUCTIVE follow-on to 0133_pay_balance_units.sql.
--
-- 0133 added the row-per-(did, unit) shape (unit/amount columns + the MJNx
-- backfill row) and left cash_amount/credit_amount in place so there was a
-- rollback point: if this migration is never applied, the old two-column
-- shape is still fully intact and readable. This migration is what actually
-- removes the superseded columns, now that every code path in this PR reads
-- and writes exclusively through `unit`/`amount`.
--
-- Rollback story: reverting this single file (re-adding the two columns and
-- backfilling them from the unit rows) is sufficient to restore the old
-- shape without touching 0133 — that migration is safe to leave applied.

ALTER TABLE pay.balances DROP COLUMN IF EXISTS cash_amount;
ALTER TABLE pay.balances DROP COLUMN IF EXISTS credit_amount;
