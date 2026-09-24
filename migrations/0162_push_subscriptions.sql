-- Migration: 0162_push_subscriptions
-- owner: kernel
-- #2291: phone push path — PWA + web-push (VAPID) on operator.approval.requested.
--
-- One row per browser/device Web Push subscription for the node operator.
-- `endpoint` is the push service's own registration URL, globally unique by
-- spec, so it is the natural upsert key for (re)subscribe. Keys are the
-- subscription's own p256dh/auth values (never the node's VAPID keypair,
-- which is a separate self-provisioned internal secret — see
-- apps/kernel/src/lib/notify/vapid.ts). `revoked_at` is a soft-delete: set
-- on an explicit unsubscribe, or when the push service reports the
-- subscription gone (404/410) on send — same posture as
-- notify.notifications' deliveredAt/read columns.
--
-- Additive alongside the existing WS push (notify.notifications /
-- delivery.ts) — this table only ever fans a persisted notification OUT to
-- a phone; it never replaces the notifications row as the source of truth.
--
-- ADDITIVE ONLY.

CREATE TABLE IF NOT EXISTS notify.push_subscriptions (
  id TEXT PRIMARY KEY,
  operator_did TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_push_subscriptions_endpoint
  ON notify.push_subscriptions (endpoint);

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_operator
  ON notify.push_subscriptions (operator_did, revoked_at);
