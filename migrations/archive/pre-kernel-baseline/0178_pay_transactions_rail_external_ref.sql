-- 0178_pay_transactions_rail_external_ref.sql
-- owner: kernel
--
-- #2176 (step 4 of 5 of the #2173 pay-rail boundary) — `rail` + `external_ref`
-- on pay.transactions, so a transaction row is no longer Stripe-shaped.
--
--   rail          which rail moved the money ('stripe', 'emt', ...).
--   external_ref  that rail's opaque reference for it (a Stripe checkout
--                 session / payment intent / invoice id today).
--
-- `stripe_id` is kept as a DEPRECATED ALIAS until step 5 (#2650) drops it:
-- code reads `external_ref` and writes BOTH columns, so the DROP is safe.
--
-- Scope (ruled "option c", 2026-09-23): this migration touches
-- pay.transactions ONLY. pay.connected_accounts stays Stripe-shaped; its
-- rename/generalization to payout_accounts is revisited at step 5.
--
-- Forward-only, additive and idempotent: ADD COLUMN IF NOT EXISTS, backfills
-- that only fill NULLs (so a re-run never overwrites a value a writer has
-- since set), CREATE INDEX IF NOT EXISTS. Rows with no `stripe_id` (internal
-- balance moves, EMT pending rows, ...) have no external reference and keep
-- NULL `rail` / `external_ref`.

ALTER TABLE pay.transactions
  ADD COLUMN IF NOT EXISTS rail text;

ALTER TABLE pay.transactions
  ADD COLUMN IF NOT EXISTS external_ref text;

-- Backfill rail. Every row carrying a `stripe_id` came through the Stripe rail
-- EXCEPT withdrawal receipts, whose `stripe_id` holds the (possibly
-- non-Stripe) external ref and whose `metadata.rail` records the rail that
-- executed them (withdraw-intent.ts confirmWithdrawal). `metadata.rail` is
-- only trusted for `type = 'withdrawal'`: other rows' metadata can carry
-- caller-supplied keys.
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

CREATE INDEX IF NOT EXISTS idx_transactions_rail_external_ref
  ON pay.transactions USING btree (rail, external_ref);
