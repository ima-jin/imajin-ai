-- 0182_pay_transactions_app_settle_binding.sql
-- owner: kernel
--
-- #2642 — app-authenticated checkout records WHO may settle a payment and WHAT
-- it may pay out, on the one audited payment table (ruled 2026-10-07, option a:
-- no parallel ledger).
--
--   app_did         DID of the registered app whose app-service token created
--                   the checkout. NULL = no app binding (user/anonymous
--                   checkout, every legacy row): such rows are never settleable
--                   through POST /pay/api/settle's app path.
--   payee_manifest  the payee manifest the app declared at checkout. The
--                   kernel verifies the `fair_manifest` chain posted at settle
--                   time against this record instead of trusting the caller.
--   settled_at      settled marker. Set atomically inside the settlement's own
--                   database transaction, so a second settle of the same
--                   payment is an idempotent replay (no double payout).
--   settle_batch_id the `batch_id` of the per-recipient rows the settlement
--                   wrote — lets a replay return the prior result.
--
-- Forward-only, additive and idempotent: nullable columns, ADD COLUMN IF NOT
-- EXISTS, no backfill of existing rows.

ALTER TABLE pay.transactions
  ADD COLUMN IF NOT EXISTS app_did text;

ALTER TABLE pay.transactions
  ADD COLUMN IF NOT EXISTS payee_manifest jsonb;

ALTER TABLE pay.transactions
  ADD COLUMN IF NOT EXISTS settled_at timestamp with time zone;

ALTER TABLE pay.transactions
  ADD COLUMN IF NOT EXISTS settle_batch_id text;

CREATE INDEX IF NOT EXISTS idx_transactions_app_did
  ON pay.transactions USING btree (app_did)
  WHERE app_did IS NOT NULL;
