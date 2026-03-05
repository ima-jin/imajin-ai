-- Add index on content_type for filtering by message type
CREATE INDEX IF NOT EXISTS idx_chat_messages_content_type ON chat.messages(content_type);
