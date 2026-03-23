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