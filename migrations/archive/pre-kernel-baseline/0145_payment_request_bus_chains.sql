-- 0145_payment_request_bus_chains.sql
-- owner: kernel
--
-- #2212 (child of #2206): `kernel.bus_chain_configs` rows for the
-- payment_request.* event family, plus the dedup table the
-- `payment-request-notify` reactor
-- (packages/bus/src/reactors/payment-request-notify.ts) uses to make a
-- replayed publish() call idempotent per (payment_request, event_type,
-- recipient/issuer target).
--
-- Kept in sync with packages/bus/src/config.ts DEFAULTS — follows the
-- reconcile convention established by migration 0098 (#1873/#1874/#1875):
-- a DB row here must match the DEFAULTS entry for the same event_type/scope
-- exactly, since getChainConfig() prefers a DB row over DEFAULTS whenever
-- one exists.
--
-- `payment_request.recipient_claimed`'s publisher (#2210/#2214,
-- `resolvePaymentRequestsOnRecipientClaim`) has since merged to main; its
-- chain row is seeded here alongside the other four for the same reason
-- as always — one migration reconciling the whole event family with
-- config.ts DEFAULTS.
--
-- Renumbered from 0144 to 0145 (mirrors the 0133 precedent documented in
-- ownership.json for kernel.google_workspace_state): 0144 collided with
-- 0144_pay_payment_request_recipient_claim.sql, independently merged to
-- main via #2214 while this branch was in flight.
--
-- ADDITIVE ONLY.

CREATE TABLE IF NOT EXISTS kernel.payment_request_notifications (
  id                 TEXT PRIMARY KEY,
  payment_request_id TEXT NOT NULL,
  event_type         TEXT NOT NULL,
  target_did         TEXT NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (payment_request_id, event_type, target_did)
);

CREATE INDEX IF NOT EXISTS idx_payment_request_notifications_request
  ON kernel.payment_request_notifications (payment_request_id);

INSERT INTO kernel.bus_chain_configs (event_type, scope, reactors, enabled)
VALUES
  (
    'payment_request.issued',
    NULL,
    '[{"type":"payment-request-notify","config":{},"enabled":true}]'::jsonb,
    true
  ),
  (
    'payment_request.paid',
    NULL,
    '[{"type":"payment-request-notify","config":{},"enabled":true}]'::jsonb,
    true
  ),
  (
    'payment_request.settled',
    NULL,
    '[{"type":"payment-request-notify","config":{},"enabled":true}]'::jsonb,
    true
  ),
  (
    'payment_request.voided',
    NULL,
    '[{"type":"payment-request-notify","config":{},"enabled":true}]'::jsonb,
    true
  ),
  (
    'payment_request.recipient_claimed',
    NULL,
    '[{"type":"payment-request-notify","config":{},"enabled":true}]'::jsonb,
    true
  )
ON CONFLICT (event_type, scope) DO UPDATE
  SET reactors = EXCLUDED.reactors,
      updated_at = now();
