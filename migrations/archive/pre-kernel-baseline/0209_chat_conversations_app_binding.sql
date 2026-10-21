-- 0209_chat_conversations_app_binding.sql
-- owner: kernel
-- Never infer an app owner for legacy conversations from writable context or membership.
ALTER TABLE IF EXISTS chat.conversations_v2
  ADD COLUMN IF NOT EXISTS app_did TEXT;
