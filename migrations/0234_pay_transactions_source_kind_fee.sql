-- owner: kernel
-- #3286: fee wallet-effect claims reuse transactions.idempotency_key.
ALTER TABLE pay.transactions
  DROP CONSTRAINT IF EXISTS pay_transactions_source_kind_check;
ALTER TABLE pay.transactions
  ADD CONSTRAINT pay_transactions_source_kind_check
  CHECK (source_kind = ANY (ARRAY['receipt', 'emission', 'transfer', 'fee']));
