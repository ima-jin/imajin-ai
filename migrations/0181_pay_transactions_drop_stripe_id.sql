-- 0181_pay_transactions_drop_stripe_id.sql
-- owner: kernel
--
-- #2650 (step 5 of 5 of the #2173 pay-rail boundary; #2177 item 5): drop the
-- Stripe-named `stripe_id` column from pay.transactions so the ledger carries
-- no Stripe-named columns. DESTRUCTIVE follow-on to
-- 0178_pay_transactions_rail_external_ref.sql (#2176), which added
-- `rail` + `external_ref`, backfilled them, and kept `stripe_id` as a
-- deprecated alias while every reader moved to `external_ref`.
--
-- Ruling (Ryan, 2026-10-06): drop in v0.8.16, after v0.8.15 shipped the alias
-- removal (#2632) to prod. As of this change nothing reads or writes
-- `stripe_id`: readers key on (rail, external_ref) and writers set only those.
--
-- Order matters:
--   1. Re-run the 0178 backfill (idempotent: it only fills NULLs, so it never
--      overwrites a value a writer has since set). This guarantees every row
--      that still has a `stripe_id` carries the same reference in
--      `external_ref` before the only other copy is destroyed. It runs only
--      while the column still exists, so a replay after the drop is a no-op.
--   2. Drop idx_transactions_stripe_id (a column drop would remove it too;
--      doing it explicitly keeps the intent reviewable).
--   3. Drop the column.
--
-- Forward-only. Rollback story: there is none by design — `stripe_id` would
-- have to be re-added and re-filled from `external_ref` (every row's
-- `external_ref` equals its former `stripe_id`). The operator's pre-merge
-- check (counts only) is in the PR body; back the column's rows up first if
-- any non-null `stripe_id` has no matching `external_ref`.

DO $backfill$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'pay'
       AND table_name = 'transactions'
       AND column_name = 'stripe_id'
  ) THEN
    -- Same rule as 0178: withdrawal receipts keep the rail that executed them
    -- (`metadata.rail`, trusted only for `type = 'withdrawal'`); every other
    -- row with a `stripe_id` came through the Stripe rail.
    UPDATE pay.transactions
       SET rail = CASE
                    WHEN type = 'withdrawal' AND NULLIF(metadata->>'rail', '') IS NOT NULL
                      THEN metadata->>'rail'
                    ELSE 'stripe'
                  END
     WHERE rail IS NULL
       AND stripe_id IS NOT NULL;

    UPDATE pay.transactions
       SET external_ref = stripe_id
     WHERE external_ref IS NULL
       AND stripe_id IS NOT NULL;
  END IF;
END
$backfill$;

DROP INDEX IF EXISTS pay.idx_transactions_stripe_id;

ALTER TABLE pay.transactions DROP COLUMN IF EXISTS stripe_id;
