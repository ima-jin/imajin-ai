-- Migration: Drop v1 chat tables
-- Part of #435: v1→v2 migration
-- Run migrate-v1-to-v2.ts first to copy data to v2 tables before applying this.

-- Drop FK on invites that references conversations.id
-- (invites.conversation_id will remain as plain text pointing to a conversation DID)
ALTER TABLE "chat"."invites" DROP CONSTRAINT IF EXISTS "invites_conversation_id_conversations_id_fk";

-- Drop v1 tables in dependency order
-- (conversation_reads, read_receipts, message_reactions, participants, messages all CASCADE from conversations)

DROP TABLE IF EXISTS "chat"."message_reactions";
DROP TABLE IF EXISTS "chat"."read_receipts";
DROP TABLE IF EXISTS "chat"."conversation_reads";
DROP TABLE IF EXISTS "chat"."participants";
DROP TABLE IF EXISTS "chat"."messages";
DROP TABLE IF EXISTS "chat"."conversations";
