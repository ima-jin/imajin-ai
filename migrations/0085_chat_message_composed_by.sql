-- Migration: 0085_chat_message_composed_by
-- Adds dual attribution to chat.messages_v2 (#1673).
--
-- from_did remains the intent-owner: the identity the message belongs to. When
-- an agent writes on a human's behalf via the X-Acting-For delegation header,
-- composed_by records the acting agent's DID so the record is honest about HOW
-- the message was composed. NULL means no delegation was used — the sender
-- composed it directly.

ALTER TABLE chat.messages_v2
  ADD COLUMN IF NOT EXISTS composed_by text;

CREATE INDEX IF NOT EXISTS idx_chat_msg_v2_composed_by
  ON chat.messages_v2 (composed_by);
