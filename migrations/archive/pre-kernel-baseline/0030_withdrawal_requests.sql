BEGIN;

ALTER TABLE pay.balances ADD COLUMN IF NOT EXISTS withdrawals_enabled BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS pay.withdrawal_requests (
  id TEXT PRIMARY KEY,
  did TEXT NOT NULL,
  amount NUMERIC(20, 8) NOT NULL,
  currency TEXT NOT NULL DEFAULT 'CAD',
  emt_email TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'requested',
  admin_notes TEXT,
  requested_at TIMESTAMPTZ DEFAULT NOW(),
  processed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_withdrawal_requests_did ON pay.withdrawal_requests(did);
CREATE INDEX IF NOT EXISTS idx_withdrawal_requests_status ON pay.withdrawal_requests(status);

COMMIT;
