-- Current sql file was generated after introspecting the database
-- If you want to run this migration please uncomment this code before executing migrations
/*
CREATE SCHEMA "chat";
--> statement-breakpoint
CREATE TABLE "chat"."conversations" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"name" text,
	"description" text,
	"avatar" text,
	"context" jsonb,
	"visibility" text DEFAULT 'private' NOT NULL,
	"trust_radius" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	"last_message_at" timestamp with time zone,
	"pod_id" text
);
--> statement-breakpoint
CREATE TABLE "chat"."messages" (
	"id" text PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"from_did" text NOT NULL,
	"content" jsonb NOT NULL,
	"content_type" text DEFAULT 'text' NOT NULL,
	"reply_to" text,
	"created_at" timestamp with time zone DEFAULT now(),
	"edited_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"media_type" text,
	"media_path" text,
	"media_meta" jsonb,
	"link_previews" jsonb
);
--> statement-breakpoint
CREATE TABLE "chat"."invites" (
	"id" text PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"created_by" text NOT NULL,
	"for_did" text,
	"max_uses" text,
	"used_count" text DEFAULT '0' NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now(),
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "chat"."public_keys" (
	"did" text PRIMARY KEY NOT NULL,
	"identity_key" text NOT NULL,
	"signed_pre_key" text NOT NULL,
	"signature" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "chat"."pre_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"did" text NOT NULL,
	"key" text NOT NULL,
	"used" boolean DEFAULT false,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "chat"."conversation_reads" (
	"conversation_id" text NOT NULL,
	"did" text NOT NULL,
	"last_read_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_reads_conversation_id_did_pk" PRIMARY KEY("conversation_id","did")
);
--> statement-breakpoint
CREATE TABLE "chat"."read_receipts" (
	"conversation_id" text NOT NULL,
	"did" text NOT NULL,
	"last_read_message_id" text,
	"read_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "read_receipts_conversation_id_did_pk" PRIMARY KEY("conversation_id","did")
);
--> statement-breakpoint
CREATE TABLE "chat"."message_reactions" (
	"message_id" text NOT NULL,
	"did" text NOT NULL,
	"emoji" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "message_reactions_message_id_did_emoji_pk" PRIMARY KEY("message_id","did","emoji")
);
--> statement-breakpoint
CREATE TABLE "chat"."participants" (
	"conversation_id" text NOT NULL,
	"did" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now(),
	"invited_by" text,
	"last_read_at" timestamp with time zone,
	"muted" boolean DEFAULT false,
	"trust_extended_to" jsonb DEFAULT '[]'::jsonb,
	CONSTRAINT "participants_conversation_id_did_pk" PRIMARY KEY("conversation_id","did")
);
--> statement-breakpoint
ALTER TABLE "chat"."messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "chat"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat"."invites" ADD CONSTRAINT "invites_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "chat"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat"."pre_keys" ADD CONSTRAINT "pre_keys_did_public_keys_did_fk" FOREIGN KEY ("did") REFERENCES "chat"."public_keys"("did") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat"."conversation_reads" ADD CONSTRAINT "conversation_reads_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "chat"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat"."read_receipts" ADD CONSTRAINT "read_receipts_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "chat"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat"."read_receipts" ADD CONSTRAINT "read_receipts_last_read_message_id_messages_id_fk" FOREIGN KEY ("last_read_message_id") REFERENCES "chat"."messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat"."message_reactions" ADD CONSTRAINT "message_reactions_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "chat"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat"."participants" ADD CONSTRAINT "participants_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "chat"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_chat_conversations_created_by" ON "chat"."conversations" USING btree ("created_by" text_ops);--> statement-breakpoint
CREATE INDEX "idx_chat_conversations_pod_id" ON "chat"."conversations" USING btree ("pod_id" text_ops);--> statement-breakpoint
CREATE INDEX "idx_chat_conversations_type" ON "chat"."conversations" USING btree ("type" text_ops);--> statement-breakpoint
CREATE INDEX "idx_chat_messages_conversation" ON "chat"."messages" USING btree ("conversation_id" text_ops);--> statement-breakpoint
CREATE INDEX "idx_chat_messages_created" ON "chat"."messages" USING btree ("created_at" timestamptz_ops);--> statement-breakpoint
CREATE INDEX "idx_chat_messages_from" ON "chat"."messages" USING btree ("from_did" text_ops);--> statement-breakpoint
CREATE INDEX "idx_chat_invites_conversation" ON "chat"."invites" USING btree ("conversation_id" text_ops);--> statement-breakpoint
CREATE INDEX "idx_chat_invites_for_did" ON "chat"."invites" USING btree ("for_did" text_ops);--> statement-breakpoint
CREATE INDEX "idx_chat_pre_keys_did" ON "chat"."pre_keys" USING btree ("did" text_ops);--> statement-breakpoint
CREATE INDEX "idx_chat_message_reactions_message" ON "chat"."message_reactions" USING btree ("message_id" text_ops);--> statement-breakpoint
CREATE INDEX "idx_chat_participants_did" ON "chat"."participants" USING btree ("did" text_ops);--> statement-breakpoint
CREATE INDEX "idx_chat_participants_role" ON "chat"."participants" USING btree ("role" text_ops);
*/