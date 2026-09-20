-- 0144_pay_payment_request_recipient_claim.sql
-- owner: kernel
--
-- #2210: recipient = known DID (verified via an existing connection) OR a
-- new counterparty via the claimable-stub + invite path (#1834 primitive).
--
-- 1. pay.payment_request.pay_handle — the opaque, unguessable "pay link"
--    handle GET /pay/api/payment-requests/by-handle/:handle keys off of.
--    Every payment_request gets one at create time (both recipient
--    shapes) so the same unauthenticated read path works whether the
--    recipient already has a DID or is still an unclaimed stub. Backfilled
--    from built-in randomness (no pgcrypto dependency) since this column
--    predates any production rows for a table that shipped in #2207/#2208.
--
-- 2. connections.invites.reason_context_id / reason_context_type — a
--    generic "this invite exists because of <context>" pointer, the same
--    context_id/context_type convention already used by attestations and
--    bus payloads throughout this codebase. #2210 is the first caller
--    (payment_request as the invite's reason, per #1839's opaque-handle
--    posture — no PII beyond this reference is exposed pre-claim), but the
--    columns are deliberately vertical-agnostic so a future caller doesn't
--    need its own pair.
--
-- ADDITIVE ONLY.

ALTER TABLE pay.payment_request ADD COLUMN IF NOT EXISTS pay_handle text;

UPDATE pay.payment_request
SET pay_handle = 'ph_' || md5(id || clock_timestamp()::text || random()::text)
WHERE pay_handle IS NULL;

ALTER TABLE pay.payment_request ALTER COLUMN pay_handle SET NOT NULL;

ALTER TABLE pay.payment_request
  ADD CONSTRAINT pay_payment_request_pay_handle_unique UNIQUE (pay_handle);

CREATE INDEX IF NOT EXISTS idx_payment_request_pay_handle ON pay.payment_request (pay_handle);

ALTER TABLE connections.invites ADD COLUMN IF NOT EXISTS reason_context_id text;
ALTER TABLE connections.invites ADD COLUMN IF NOT EXISTS reason_context_type text;

CREATE INDEX IF NOT EXISTS idx_invites_reason_context_id ON connections.invites (reason_context_id)
  WHERE reason_context_id IS NOT NULL;
