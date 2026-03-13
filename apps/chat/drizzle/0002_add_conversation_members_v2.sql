-- Add conversation members table for v2 DID-based conversations
-- Tracks group membership so members can discover conversations before sending/reading

CREATE TABLE IF NOT EXISTS chat.conversation_members_v2 (
  conversation_did TEXT NOT NULL REFERENCES chat.conversations_v2(did) ON DELETE CASCADE,
  did TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  added_by TEXT,
  joined_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (conversation_did, did)
);

CREATE INDEX IF NOT EXISTS idx_chat_members_v2_did ON chat.conversation_members_v2(did);
