-- 0143_pay_payment_requests.sql
-- owner: kernel
--
-- #2206/#2207: pay.payment_request — an invoice / money request as a
-- first-class receivable on the business DID.
--
-- fair_manifest is NOT NULL: every payment_request carries a .fair
-- manifest (the simple case is a single-payee manifest — one payee, one
-- customer; .fair makes the split configurable, it isn't a
-- multi-party-only feature).
--
-- Exactly one of recipient_did / recipient_stub_id must be set at create
-- time — enforced here via a CHECK constraint rather than deferred to the
-- route layer, per this repo's payment_request hard requirements.
--
-- kind/status are plain text + CHECK constraints rather than native
-- Postgres ENUMs, matching 0142_pay_withdrawal_intents.sql's convention —
-- additive-only, no ALTER TYPE needed to widen later.
--
-- ADDITIVE ONLY.

CREATE TABLE IF NOT EXISTS pay.payment_request (
  id text PRIMARY KEY,
  kind text NOT NULL DEFAULT 'invoice',
  issuer_did text NOT NULL,
  payee_account text NOT NULL,
  recipient_did text,
  recipient_stub_id text,
  line_items jsonb NOT NULL,
  currency text NOT NULL DEFAULT 'CAD',
  total_amount integer NOT NULL,
  fair_manifest jsonb NOT NULL,
  due_at timestamptz,
  allow_on_platform boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'issued',
  settlement_ref jsonb,
  content_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE pay.payment_request
  ADD CONSTRAINT pay_payment_request_kind_check
  CHECK (kind IN ('invoice', 'request'));

ALTER TABLE pay.payment_request
  ADD CONSTRAINT pay_payment_request_status_check
  CHECK (status IN ('issued', 'paid', 'settled_manual', 'void'));

ALTER TABLE pay.payment_request
  ADD CONSTRAINT pay_payment_request_recipient_xor_check
  CHECK (
    (recipient_did IS NOT NULL AND recipient_stub_id IS NULL)
    OR (recipient_did IS NULL AND recipient_stub_id IS NOT NULL)
  );

CREATE INDEX IF NOT EXISTS idx_payment_request_issuer_did ON pay.payment_request (issuer_did);
CREATE INDEX IF NOT EXISTS idx_payment_request_recipient_did ON pay.payment_request (recipient_did);
CREATE INDEX IF NOT EXISTS idx_payment_request_recipient_stub_id ON pay.payment_request (recipient_stub_id);
CREATE INDEX IF NOT EXISTS idx_payment_request_status ON pay.payment_request (status);
