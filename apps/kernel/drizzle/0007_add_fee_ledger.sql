CREATE TABLE IF NOT EXISTS pay.fee_ledger (
  id TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL,
  recipient_did TEXT NOT NULL,
  role TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'accrued',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fee_ledger_tx ON pay.fee_ledger (transaction_id);
CREATE INDEX IF NOT EXISTS idx_fee_ledger_recipient ON pay.fee_ledger (recipient_did, status);
