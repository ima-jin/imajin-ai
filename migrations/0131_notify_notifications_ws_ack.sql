-- 0131_notify_notifications_ws_ack.sql
-- WS heartbeat + ack-confirmed delivery (#2099, Candidate A for #2098).
--
-- #2044/migration 0129 gave `delivered_at` a single meaning: "reached a live
-- WS frame at least once". That collapsed a real gap: `sendToDid` reports
-- `sent = true` (readyState === 1) the instant a frame is handed to the
-- socket, which is also true for a socket whose peer already crashed
-- without a clean close -- there is no ack anywhere in that path. Once
-- `delivered_at` was set, `getNotificationBacklog`'s `delivered_at IS NULL`
-- filter permanently excluded the row from replay, silently stranding it
-- (see docs/warp-notification-chain.md, incidents 2026-09-08).
--
-- This migration does not touch the meaning of `delivered_at` at the SQL
-- level -- it is still "the recipient's plugin has this" -- but the kernel
-- code now sets it ONLY from an explicit `{ type: 'notification_ack' }`
-- frame (apps/kernel/src/lib/notify/delivery.ts's `ackNotificationDelivery`),
-- never merely because a socket accepted a `.send()` call. Two new columns
-- separate "attempted a WS send" from "confirmed delivered":
--
--   ws_sent_at    -- when this row's most recent WS send attempt (live push
--                    or backlog replay) was claimed. NULL means "never
--                    attempted, or its claim was released". An un-acked
--                    claim older than the 30s ack timeout, or explicitly
--                    released because its socket's heartbeat found it dead
--                    (releaseWsClaimsForDid), is eligible for another WS
--                    send attempt again.
--   ws_attempts   -- cumulative count of WS send attempts for this row,
--                    capped at 3 (claimNotificationForWsSend) so a plugin
--                    that never sends the ack frame cannot be re-offered
--                    the same notification indefinitely across reconnects.
--
-- Both are claimed atomically alongside `delivered_at IS NULL` by
-- `claimNotificationForWsSend`, so a live push and a backlog replay still
-- can never deliver -- or claim an attempt at -- the same row at once.
ALTER TABLE notify.notifications
  ADD COLUMN IF NOT EXISTS ws_sent_at TIMESTAMPTZ;

ALTER TABLE notify.notifications
  ADD COLUMN IF NOT EXISTS ws_attempts INTEGER NOT NULL DEFAULT 0;
