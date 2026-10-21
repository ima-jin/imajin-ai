-- 0173_pay_payment_request_emt_pending.sql
-- owner: kernel
--
-- #2665 — Interac e-Transfer pay-in rail for payment requests.
--
-- A payer who chooses to settle by e-Transfer moves the request from
-- `issued` to the new `emt_pending` status ("payer says they sent it,
-- issuer has not confirmed receipt yet"). The issuer's "Mark paid
-- (e-Transfer)" then moves it to `paid` through the same guarded
-- compare-and-swap the Stripe webhook uses, so exactly one settlement can
-- ever win across the card and e-Transfer rails.
--
-- `status` is plain text + CHECK (0143), so widening it is a constraint
-- swap, not an ALTER TYPE. Every existing row already satisfies the wider
-- constraint. Idempotent: DROP ... IF EXISTS then ADD.
--
-- ADDITIVE ONLY — no row is rewritten and no value is removed.

ALTER TABLE pay.payment_request
  DROP CONSTRAINT IF EXISTS pay_payment_request_status_check;

ALTER TABLE pay.payment_request
  ADD CONSTRAINT pay_payment_request_status_check
  CHECK (status IN ('issued', 'emt_pending', 'paid', 'settled_manual', 'void'));
