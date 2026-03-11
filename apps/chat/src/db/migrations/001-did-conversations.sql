-- Migration: 001-did-conversations
-- DID-based conversation tables (additive — does not modify existing tables)

CREATE TABLE IF NOT EXISTS chat.conversations_v2 (
  did          TEXT PRIMARY KEY,           -- did:imajin:dm:<hash> or did:imajin:group:<hash>
  parent_did   TEXT,                       -- optional parent conversation DID
  name         TEXT,
  created_by   TEXT NOT NULL,             -- DID of creator
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW(),
  last_message_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_chat_conv_v2_created_by    ON chat.conversations_v2 (created_by);
CREATE INDEX IF NOT EXISTS idx_chat_conv_v2_parent_did    ON chat.conversations_v2 (parent_did);
CREATE INDEX IF NOT EXISTS idx_chat_conv_v2_last_message  ON chat.conversations_v2 (last_message_at DESC);


CREATE TABLE IF NOT EXISTS chat.messages_v2 (
  id                  TEXT PRIMARY KEY,   -- msg_xxx
  conversation_did    TEXT NOT NULL REFERENCES chat.conversations_v2 (did) ON DELETE CASCADE,
  from_did            TEXT NOT NULL,

  -- Threading
  reply_to_did        TEXT,               -- DID of conversation being replied into (cross-conv)
  reply_to_message_id TEXT,              -- ID of message being replied to

  -- Content
  content             JSONB NOT NULL,     -- { encrypted, nonce } or { type: 'system', text }
  content_type        TEXT NOT NULL DEFAULT 'text',

  -- Media attachments
  media_type          TEXT,              -- 'image' | 'file' | 'audio' | null
  media_path          TEXT,
  media_meta          JSONB,             -- { width, height, size, originalName, mimeType, thumbnailPath }

  -- Link previews
  link_previews       JSONB,             -- [{ url, title, description, image, favicon, siteName }]

  -- Status
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  edited_at           TIMESTAMPTZ,
  deleted_at          TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_chat_msg_v2_conversation ON chat.messages_v2 (conversation_did);
CREATE INDEX IF NOT EXISTS idx_chat_msg_v2_from         ON chat.messages_v2 (from_did);
CREATE INDEX IF NOT EXISTS idx_chat_msg_v2_created      ON chat.messages_v2 (created_at DESC);


CREATE TABLE IF NOT EXISTS chat.message_reactions_v2 (
  message_id  TEXT NOT NULL REFERENCES chat.messages_v2 (id) ON DELETE CASCADE,
  did         TEXT NOT NULL,
  emoji       TEXT NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (message_id, did, emoji)
);

CREATE INDEX IF NOT EXISTS idx_chat_react_v2_message ON chat.message_reactions_v2 (message_id);


CREATE TABLE IF NOT EXISTS chat.conversation_reads_v2 (
  conversation_did  TEXT NOT NULL REFERENCES chat.conversations_v2 (did) ON DELETE CASCADE,
  did               TEXT NOT NULL,
  last_read_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (conversation_did, did)
);

CREATE INDEX IF NOT EXISTS idx_chat_reads_v2_did ON chat.conversation_reads_v2 (did);
