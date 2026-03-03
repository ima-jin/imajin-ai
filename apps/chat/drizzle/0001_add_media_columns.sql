-- Add media columns to chat_messages table
ALTER TABLE "chat_messages" ADD COLUMN "media_type" text;
ALTER TABLE "chat_messages" ADD COLUMN "media_path" text;
ALTER TABLE "chat_messages" ADD COLUMN "media_meta" jsonb;
