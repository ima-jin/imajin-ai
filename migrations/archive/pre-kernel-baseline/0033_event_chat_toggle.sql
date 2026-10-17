-- Event chat enable/disable toggle + conversation name display policy
-- Issue #460

-- Part 1: chat toggle on events
ALTER TABLE events.events ADD COLUMN IF NOT EXISTS chat_enabled BOOLEAN NOT NULL DEFAULT true;

-- Part 2: name display policy on conversations (stored in context jsonb)
-- No schema change needed — uses existing context jsonb column on chat.conversations_v2
