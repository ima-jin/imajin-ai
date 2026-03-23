ALTER TABLE "chat"."conversation_reads" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "chat"."conversations" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "chat"."message_reactions" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "chat"."messages" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "chat"."participants" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "chat"."read_receipts" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "chat"."conversation_reads" CASCADE;--> statement-breakpoint
DROP TABLE "chat"."conversations" CASCADE;--> statement-breakpoint
DROP TABLE "chat"."message_reactions" CASCADE;--> statement-breakpoint
DROP TABLE "chat"."messages" CASCADE;--> statement-breakpoint
DROP TABLE "chat"."participants" CASCADE;--> statement-breakpoint
DROP TABLE "chat"."read_receipts" CASCADE;--> statement-breakpoint
ALTER TABLE "chat"."invites" DROP CONSTRAINT "invites_conversation_id_conversations_id_fk";
--> statement-breakpoint
ALTER TABLE "chat"."messages_v2" ADD COLUMN "media_asset_id" text;--> statement-breakpoint
ALTER TABLE "chat"."messages_v2" ADD COLUMN "signature" text;