-- 0141_pay_withdrawal_intents.sql
-- owner: kernel
--
-- #2172: withdrawal intent + rail-agnostic Stripe<->ledger reconciler.
--
-- Prevention layer (reserve -> external -> confirm): `pay.withdrawal_intents`
-- makes the intent id durable BEFORE any external rail call is ever made, so
-- a crash between "rail succeeded" and "ledger commit" is detectable
-- (pending intent + no matching external transfer, or completed intent +
-- matching external transfer that never got its ledger row) instead of
-- silently losing the fact a payout attempt happened at all.
--
-- Rail-agnostic per the issue's design amendment (Ryan, "is this going to
-- tightly couple Stripe to the kernel?"): no Stripe-named column. `rail` is
-- a free-text adapter name (e.g. 'stripe'); `external_ref` is opaque to the
-- kernel — the WithdrawRail adapter is the only code that knows what it
-- means for a given rail.
--
-- ADDITIVE ONLY.

CREATE TABLE IF NOT EXISTS pay.withdrawal_intents (
  id text PRIMARY KEY,
  did text NOT NULL,
  unit text NOT NULL,
  amount numeric(20, 8) NOT NULL,
  rail text NOT NULL,
  -- Passed to the rail adapter's execute() as its native idempotency key
  -- (e.g. Stripe's `idempotencyKey`) so a retry against an already-reserved
  -- intent can never produce a second external transfer.
  idempotency_key text NOT NULL UNIQUE,
  -- Opaque external transfer reference (e.g. a Stripe transfer id). NULL
  -- until the rail call succeeds and the confirming transaction commits.
  external_ref text,
  status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE pay.withdrawal_intents
  ADD CONSTRAINT pay_withdrawal_intents_status_check
  CHECK (status IN ('pending', 'completed', 'failed', 'released'));

CREATE INDEX IF NOT EXISTS idx_pay_withdrawal_intents_did ON pay.withdrawal_intents (did);
CREATE INDEX IF NOT EXISTS idx_pay_withdrawal_intents_status ON pay.withdrawal_intents (status);
CREATE INDEX IF NOT EXISTS idx_pay_withdrawal_intents_rail ON pay.withdrawal_intents (rail);
CREATE INDEX IF NOT EXISTS idx_pay_withdrawal_intents_external_ref ON pay.withdrawal_intents (external_ref);

-- Detection layer: the reconciliation cron sweep needs to persist how far it
-- has already scanned each rail's transfer feed (`rail.list({ since })`) so
-- a run never rescans a rail's entire history and never silently skips a
-- window between runs. One row per registered rail name.
CREATE TABLE IF NOT EXISTS pay.reconciliation_watermarks (
  rail text PRIMARY KEY,
  last_reconciled_at timestamptz NOT NULL DEFAULT '1970-01-01T00:00:00Z',
  updated_at timestamptz NOT NULL DEFAULT now()
);
