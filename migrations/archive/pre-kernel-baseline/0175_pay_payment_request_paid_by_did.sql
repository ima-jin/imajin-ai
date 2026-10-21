-- 0175_pay_payment_request_paid_by_did.sql
-- owner: kernel
--
-- #2656 Phase 2 — the payer chooses which of their DIDs pays a payment request.
--
-- The invoice stays addressed to `recipient_did`; `paid_by_did` records the DID
-- the payer actually chose to pay as (their own DID, or an org/business DID
-- where they hold owner/admin in auth.identity_members). Settlement `from_did`,
-- the .fair buyer, the settlement attestation and the receipt all read
-- `paid_by_did ?? recipient_did`.
--
-- NULL (the default) means "no choice recorded" — every pre-existing row, and
-- any request paid without picking a DID, keeps settling as its recipient.
-- Set at checkout time (card) or when the payer chooses e-Transfer, always
-- after the server has verified the caller controls the DID.
--
-- ADDITIVE, FORWARD-ONLY — no row is rewritten, nothing is dropped.

ALTER TABLE pay.payment_request
  ADD COLUMN IF NOT EXISTS paid_by_did text;
