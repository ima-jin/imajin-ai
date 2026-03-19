ALTER TABLE "chat"."conversations_v2" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "chat"."messages_v2" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "chat"."conversation_reads_v2" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "chat"."message_reactions_v2" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "chat"."conversations_v2" CASCADE;--> statement-breakpoint
DROP TABLE "chat"."messages_v2" CASCADE;--> statement-breakpoint
DROP TABLE "chat"."conversation_reads_v2" CASCADE;--> statement-breakpoint
DROP TABLE "chat"."message_reactions_v2" CASCADE;--> statement-breakpoint
ALTER TABLE "chat"."messages" DROP CONSTRAINT "chat_messages_conversation_id_chat_conversations_id_fk";
--> statement-breakpoint
ALTER TABLE "chat"."invites" DROP CONSTRAINT "chat_invites_conversation_id_chat_conversations_id_fk";
--> statement-breakpoint
ALTER TABLE "chat"."pre_keys" DROP CONSTRAINT "chat_pre_keys_did_chat_public_keys_did_fk";
--> statement-breakpoint
ALTER TABLE "chat"."conversation_reads" DROP CONSTRAINT "conversation_reads_conversation_id_chat_conversations_id_fk";
--> statement-breakpoint
ALTER TABLE "chat"."read_receipts" DROP CONSTRAINT "chat_read_receipts_conversation_id_chat_conversations_id_fk";
--> statement-breakpoint
ALTER TABLE "chat"."read_receipts" DROP CONSTRAINT "chat_read_receipts_last_read_message_id_chat_messages_id_fk";
--> statement-breakpoint
ALTER TABLE "chat"."message_reactions" DROP CONSTRAINT "chat_message_reactions_message_id_chat_messages_id_fk";
--> statement-breakpoint
ALTER TABLE "chat"."participants" DROP CONSTRAINT "chat_participants_conversation_id_chat_conversations_id_fk";
--> statement-breakpoint
DROP INDEX "chat"."idx_chat_messages_content_type";--> statement-breakpoint
DROP INDEX "chat"."idx_chat_conversations_created_by";--> statement-breakpoint
DROP INDEX "chat"."idx_chat_conversations_pod_id";--> statement-breakpoint
DROP INDEX "chat"."idx_chat_conversations_type";--> statement-breakpoint
DROP INDEX "chat"."idx_chat_messages_conversation";--> statement-breakpoint
DROP INDEX "chat"."idx_chat_messages_created";--> statement-breakpoint
DROP INDEX "chat"."idx_chat_messages_from";--> statement-breakpoint
DROP INDEX "chat"."idx_chat_invites_conversation";--> statement-breakpoint
DROP INDEX "chat"."idx_chat_invites_for_did";--> statement-breakpoint
DROP INDEX "chat"."idx_chat_pre_keys_did";--> statement-breakpoint
DROP INDEX "chat"."idx_chat_message_reactions_message";--> statement-breakpoint
DROP INDEX "chat"."idx_chat_participants_did";--> statement-breakpoint
DROP INDEX "chat"."idx_chat_participants_role";--> statement-breakpoint
ALTER TABLE "chat"."read_receipts" DROP CONSTRAINT "chat_read_receipts_conversation_id_did_pk";--> statement-breakpoint
ALTER TABLE "chat"."message_reactions" DROP CONSTRAINT "chat_message_reactions_message_id_did_emoji_pk";--> statement-breakpoint
ALTER TABLE "chat"."participants" DROP CONSTRAINT "chat_participants_conversation_id_did_pk";--> statement-breakpoint
ALTER TABLE "chat"."read_receipts" ADD CONSTRAINT "read_receipts_conversation_id_did_pk" PRIMARY KEY("conversation_id","did");--> statement-breakpoint
ALTER TABLE "chat"."message_reactions" ADD CONSTRAINT "message_reactions_message_id_did_emoji_pk" PRIMARY KEY("message_id","did","emoji");--> statement-breakpoint
ALTER TABLE "chat"."participants" ADD CONSTRAINT "participants_conversation_id_did_pk" PRIMARY KEY("conversation_id","did");--> statement-breakpoint
ALTER TABLE "chat"."messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "chat"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat"."invites" ADD CONSTRAINT "invites_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "chat"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat"."pre_keys" ADD CONSTRAINT "pre_keys_did_public_keys_did_fk" FOREIGN KEY ("did") REFERENCES "chat"."public_keys"("did") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat"."conversation_reads" ADD CONSTRAINT "conversation_reads_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "chat"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat"."read_receipts" ADD CONSTRAINT "read_receipts_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "chat"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat"."read_receipts" ADD CONSTRAINT "read_receipts_last_read_message_id_messages_id_fk" FOREIGN KEY ("last_read_message_id") REFERENCES "chat"."messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat"."message_reactions" ADD CONSTRAINT "message_reactions_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "chat"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat"."participants" ADD CONSTRAINT "participants_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "chat"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_chat_conversations_created_by" ON "chat"."conversations" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "idx_chat_conversations_pod_id" ON "chat"."conversations" USING btree ("pod_id");--> statement-breakpoint
CREATE INDEX "idx_chat_conversations_type" ON "chat"."conversations" USING btree ("type");--> statement-breakpoint
CREATE INDEX "idx_chat_messages_conversation" ON "chat"."messages" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "idx_chat_messages_created" ON "chat"."messages" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_chat_messages_from" ON "chat"."messages" USING btree ("from_did");--> statement-breakpoint
CREATE INDEX "idx_chat_invites_conversation" ON "chat"."invites" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "idx_chat_invites_for_did" ON "chat"."invites" USING btree ("for_did");--> statement-breakpoint
CREATE INDEX "idx_chat_pre_keys_did" ON "chat"."pre_keys" USING btree ("did");--> statement-breakpoint
CREATE INDEX "idx_chat_message_reactions_message" ON "chat"."message_reactions" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "idx_chat_participants_did" ON "chat"."participants" USING btree ("did");--> statement-breakpoint
CREATE INDEX "idx_chat_participants_role" ON "chat"."participants" USING btree ("role");