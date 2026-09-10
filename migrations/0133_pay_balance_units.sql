-- 0133_pay_balance_units.sql
-- owner: kernel
--
-- #2016: split pay.balances into row-per-(did, unit) so MJN (receipt-backed,
-- withdrawable) and MJNx (emitted, in-platform, never withdrawable) are
-- distinct ledger rows instead of two columns sharing one freeform
-- `currency` text field. See #2016, #2012 audit comment, #738 Decisions.
--
-- ADDITIVE ONLY. This migration adds columns/rows and backfills; it does
-- NOT drop cash_amount/credit_amount. The destructive drop is a SEPARATE
-- follow-on migration (0134_pay_balance_units_drop_legacy_columns.sql) in
-- the same PR, so there is an explicit rollback point between the two:
-- if 0134 has not run yet, the old two-column shape is still intact and
-- every pre-#2016 read/write path still works unmodified.

-- 1. Add the new discriminator + amount columns (nullable for now).
ALTER TABLE pay.balances ADD COLUMN IF NOT EXISTS unit text;
ALTER TABLE pay.balances ADD COLUMN IF NOT EXISTS amount numeric(20, 8);

-- 2. Turn every existing (one row per DID) row into the MJN row: MJN is the
-- receipt-backed, withdrawable unit, which is exactly what cash_amount was.
UPDATE pay.balances
SET unit = 'MJN', amount = cash_amount
WHERE unit IS NULL;

-- 3. Insert the MJNx row per DID from the old credit_amount bucket. MJNx is
-- the emitted, in-platform, non-withdrawable unit — this is exactly what
-- credit_amount held (the #2012 audit found `credit_amount` is what the
-- ruling calls MJNx, mislabeled as `currency='MJN'` in a few call sites).
-- withdrawals_enabled is never carried onto the MJNx row: MJNx can never be
-- withdrawn, full stop, regardless of what the DID's cash withdrawal flag was.
INSERT INTO pay.balances (did, unit, amount, currency, withdrawals_enabled, updated_at)
SELECT did, 'MJNx', credit_amount, currency, false, updated_at
FROM pay.balances
WHERE unit = 'MJN';

-- 4. Every row must have a unit and an amount from here on.
ALTER TABLE pay.balances ALTER COLUMN unit SET NOT NULL;
ALTER TABLE pay.balances ALTER COLUMN amount SET NOT NULL;
ALTER TABLE pay.balances ALTER COLUMN amount SET DEFAULT '0';

-- 5. Replace the single-column PK (did) with the composite (did, unit) PK —
-- there are now up to two rows per DID. The existing constraint is named
-- `balances_pkey` (0001_seed.sql:1401), not schema-prefixed.
ALTER TABLE pay.balances DROP CONSTRAINT IF EXISTS balances_pkey;
ALTER TABLE pay.balances ADD CONSTRAINT balances_pkey PRIMARY KEY (did, unit);

-- 6. Constrain unit to the two known wallet units, reserving ISO-4217-shaped
-- codes (e.g. a future fiat-native row) per decision 1's "enum/CHECK (MJN,
-- MJNx, ISO fiat codes as needed)" — none are populated by this migration.
ALTER TABLE pay.balances ADD CONSTRAINT pay_balances_unit_check
  CHECK (unit = 'MJN' OR unit = 'MJNx' OR unit ~ '^[A-Z]{3}$');

CREATE INDEX IF NOT EXISTS idx_pay_balances_unit ON pay.balances (unit);

-- ---------------------------------------------------------------------------
-- pay.transactions: add unit / source_kind / attestation_id (#2016 scope
-- item 3 — every transaction row must carry its unit, its provenance kind,
-- and (for emissions) the attestation it was minted against).
-- ---------------------------------------------------------------------------
ALTER TABLE pay.transactions ADD COLUMN IF NOT EXISTS unit text;
ALTER TABLE pay.transactions ADD COLUMN IF NOT EXISTS source_kind text;
ALTER TABLE pay.transactions ADD COLUMN IF NOT EXISTS attestation_id text;

-- Backfill by type/service. This is a best-effort reconstruction for
-- historical rows — the audit (#2012 comment, §6) already found the old
-- shape is "not fully reconstructable after the fact" once a credit-sourced
-- amount has been laundered into cash via transfer/settle. Rows whose
-- `amount` historically combined both an MJN leg and an MJNx leg (gift,
-- event-topup) are tagged MJN here as the dominant/cash leg; this is an
-- approximation for pre-#2016 history only — going forward, gift/event-topup
-- write one transaction row per unit leg (see #2016 PR).
UPDATE pay.transactions SET unit = 'MJNx', source_kind = 'emission'
WHERE type = 'emission' AND unit IS NULL;

UPDATE pay.transactions SET unit = 'MJN', source_kind = 'receipt'
WHERE type IN ('topup', 'withdrawal', 'refund') AND unit IS NULL;

UPDATE pay.transactions SET unit = 'MJN', source_kind = 'transfer'
WHERE unit IS NULL;

ALTER TABLE pay.transactions ALTER COLUMN unit SET NOT NULL;
ALTER TABLE pay.transactions ALTER COLUMN unit SET DEFAULT 'MJN';
ALTER TABLE pay.transactions ALTER COLUMN source_kind SET NOT NULL;
ALTER TABLE pay.transactions ALTER COLUMN source_kind SET DEFAULT 'transfer';

ALTER TABLE pay.transactions ADD CONSTRAINT pay_transactions_source_kind_check
  CHECK (source_kind IN ('receipt', 'emission', 'transfer'));
ALTER TABLE pay.transactions ADD CONSTRAINT pay_transactions_unit_check
  CHECK (unit = 'MJN' OR unit = 'MJNx' OR unit ~ '^[A-Z]{3}$');

CREATE INDEX IF NOT EXISTS idx_pay_transactions_unit ON pay.transactions (unit);
CREATE INDEX IF NOT EXISTS idx_pay_transactions_attestation_id ON pay.transactions (attestation_id);
