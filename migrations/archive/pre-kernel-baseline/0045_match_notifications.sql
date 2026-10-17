-- 0045_match_notifications.sql
-- Match notification queue for broker agent delivery (Issue #1101)
-- When the match engine surfaces a match, a row is written here per recipient.
-- The broker agent polls this table to deliver notifications to the right chat.

CREATE TABLE IF NOT EXISTS kernel.match_notifications (
  id              TEXT PRIMARY KEY,
  match_id        TEXT NOT NULL,           -- the broker release ID from the match engine
  recipient_did   TEXT NOT NULL,           -- the DID that should receive this notification
  other_did       TEXT,                    -- the other party's DID (null if sensitive_staged)
  overlap_tags    TEXT[] NOT NULL,
  is_sensitive    BOOLEAN NOT NULL DEFAULT false,
  delivery_policy TEXT NOT NULL,           -- 'named_nudge' | 'staged' | 'sensitive_staged'
  delivered_at    TIMESTAMPTZ,            -- null = pending; set when bot delivers to chat
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_match_notifications_recipient
  ON kernel.match_notifications (recipient_did, delivered_at)
  WHERE delivered_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_match_notifications_created
  ON kernel.match_notifications (created_at);
