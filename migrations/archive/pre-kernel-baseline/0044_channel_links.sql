-- 0044_channel_links.sql
-- Messenger identity linking — binds external channel accounts to Imajin DIDs (Issue #1100)
-- Enables a broker bot to resolve a Telegram/WhatsApp chat user to their DID
-- and make broker requests via actingFor on their behalf.

-- ---------------------------------------------------------------------------
-- Ephemeral single-use challenge tokens (the handshake)
-- Bot creates a token; user opens the URL; token is consumed on approve.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS auth.channel_link_tokens (
  id               TEXT PRIMARY KEY,
  token            TEXT NOT NULL UNIQUE,       -- random URL-safe token sent to the user
  channel          TEXT NOT NULL,              -- 'telegram' | 'whatsapp' | 'signal'
  channel_uid      TEXT NOT NULL,              -- external account id (e.g. Telegram chat_id)
  app_did          TEXT NOT NULL,              -- the bot app DID that initiated the link
  requested_scopes JSONB NOT NULL DEFAULT '[]', -- scopes the bot is requesting
  expires_at       TIMESTAMPTZ NOT NULL,       -- short TTL (15 min)
  consumed_at      TIMESTAMPTZ,               -- set when the user approves (single-use)
  consumed_by      TEXT,                       -- the Imajin DID that consumed it
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_channel_link_tokens_token
  ON auth.channel_link_tokens (token);

CREATE INDEX IF NOT EXISTS idx_channel_link_tokens_pending
  ON auth.channel_link_tokens (expires_at)
  WHERE consumed_at IS NULL;

-- ---------------------------------------------------------------------------
-- Persistent channel-account ↔ DID bindings
-- UNIQUE(channel, channel_uid, app_did): one active binding per (account, bot)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS auth.channel_links (
  id          TEXT PRIMARY KEY,
  channel     TEXT NOT NULL,                          -- 'telegram' | 'whatsapp' | 'signal'
  channel_uid TEXT NOT NULL,                          -- external account id
  did         TEXT NOT NULL,                          -- linked Imajin user DID
  app_did     TEXT NOT NULL,                          -- the bot app this link authorizes
  scopes      JSONB NOT NULL DEFAULT '[]',            -- scopes the user approved
  status      TEXT NOT NULL DEFAULT 'active',         -- 'active' | 'revoked'
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at  TIMESTAMPTZ,
  UNIQUE (channel, channel_uid, app_did)
);

CREATE INDEX IF NOT EXISTS idx_channel_links_did
  ON auth.channel_links (did);

CREATE INDEX IF NOT EXISTS idx_channel_links_lookup
  ON auth.channel_links (channel, channel_uid, status);
