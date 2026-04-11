CREATE TABLE IF NOT EXISTS registry.newsletter_sends (
  id TEXT PRIMARY KEY,
  sender_did TEXT NOT NULL,
  subject TEXT NOT NULL,
  audience_type TEXT NOT NULL,
  audience_id TEXT,
  recipient_count INTEGER NOT NULL DEFAULT 0,
  sent_at TIMESTAMPTZ DEFAULT NOW()
);
