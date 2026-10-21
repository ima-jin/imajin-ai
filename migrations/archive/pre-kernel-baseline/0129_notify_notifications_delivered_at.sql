-- 0129_notify_notifications_delivered_at.sql
-- Redelivery/catch-up for a notification that misses its live WS push (#2044).
--
-- `read` already means "the recipient opened this notification in the UI"
-- (set by POST /notify/api/notifications/[id]/read). `delivered_at` is a
-- separate concept -- "this notification reached a live WebSocket frame at
-- least once" -- and must never be conflated with `read`: a notification is
-- routinely delivered without ever being read.
--
-- NULL means "never delivered": both a notification created while nobody was
-- connected, and a live push attempt that found no open socket for the
-- recipient (docs/warp-notification-chain.md Hop 3, "Incidents 2026-09-05"
-- (a)/(b)). The WS connection handler in ws-server.js replays exactly these
-- rows -- oldest first, capped -- immediately after a DID reconnects
-- (apps/kernel/src/lib/notify/backlog.ts). `delivered_at` doubles as the
-- mutual-exclusion guard between that replay and a live push racing it: both
-- paths claim a row with an atomic
-- `UPDATE ... WHERE delivered_at IS NULL RETURNING` before pushing, so a
-- notification is never delivered twice (apps/kernel/src/lib/notify/delivery.ts).

ALTER TABLE notify.notifications
  ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ;

-- Backs the backlog-on-reconnect query: "undelivered, unread rows for this
-- DID, oldest first" (getNotificationBacklog, apps/kernel/src/lib/notify/backlog.ts).
CREATE INDEX IF NOT EXISTS idx_notifications_undelivered
  ON notify.notifications (recipient_did, created_at)
  WHERE delivered_at IS NULL AND read = false;
