CREATE SCHEMA "chat";
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
CREATE TABLE "chat"."pre_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"did" text NOT NULL,
	"key" text NOT NULL,
	"used" boolean DEFAULT false,
	"created_at" timestamp with time zone DEFAULT now()
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
CREATE TABLE "chat"."conversation_reads_v2" (
	"conversation_did" text NOT NULL,
	"did" text NOT NULL,
	"last_read_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_reads_v2_conversation_did_did_pk" PRIMARY KEY("conversation_did","did")
);
--> statement-breakpoint
CREATE TABLE "chat"."conversations_v2" (
	"did" text PRIMARY KEY NOT NULL,
	"parent_did" text,
	"name" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	"last_message_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "chat"."message_reactions_v2" (
	"message_id" text NOT NULL,
	"did" text NOT NULL,
	"emoji" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "message_reactions_v2_message_id_did_emoji_pk" PRIMARY KEY("message_id","did","emoji")
);
--> statement-breakpoint
CREATE TABLE "chat"."messages_v2" (
	"id" text PRIMARY KEY NOT NULL,
	"conversation_did" text NOT NULL,
	"from_did" text NOT NULL,
	"reply_to_did" text,
	"reply_to_message_id" text,
	"content" jsonb NOT NULL,
	"content_type" text DEFAULT 'text' NOT NULL,
	"media_type" text,
	"media_path" text,
	"media_asset_id" text,
	"media_meta" jsonb,
	"link_previews" jsonb,
	"created_at" timestamp with time zone DEFAULT now(),
	"edited_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"signature" text
);
--> statement-breakpoint
ALTER TABLE "chat"."pre_keys" ADD CONSTRAINT "pre_keys_did_public_keys_did_fk" FOREIGN KEY ("did") REFERENCES "chat"."public_keys"("did") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat"."conversation_reads_v2" ADD CONSTRAINT "conversation_reads_v2_conversation_did_conversations_v2_did_fk" FOREIGN KEY ("conversation_did") REFERENCES "chat"."conversations_v2"("did") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat"."message_reactions_v2" ADD CONSTRAINT "message_reactions_v2_message_id_messages_v2_id_fk" FOREIGN KEY ("message_id") REFERENCES "chat"."messages_v2"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat"."messages_v2" ADD CONSTRAINT "messages_v2_conversation_did_conversations_v2_did_fk" FOREIGN KEY ("conversation_did") REFERENCES "chat"."conversations_v2"("did") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_chat_invites_conversation" ON "chat"."invites" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "idx_chat_invites_for_did" ON "chat"."invites" USING btree ("for_did");--> statement-breakpoint
CREATE INDEX "idx_chat_pre_keys_did" ON "chat"."pre_keys" USING btree ("did");--> statement-breakpoint
CREATE INDEX "idx_chat_reads_v2_did" ON "chat"."conversation_reads_v2" USING btree ("did");--> statement-breakpoint
CREATE INDEX "idx_chat_conv_v2_created_by" ON "chat"."conversations_v2" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "idx_chat_conv_v2_parent_did" ON "chat"."conversations_v2" USING btree ("parent_did");--> statement-breakpoint
CREATE INDEX "idx_chat_conv_v2_last_message" ON "chat"."conversations_v2" USING btree ("last_message_at");--> statement-breakpoint
CREATE INDEX "idx_chat_react_v2_message" ON "chat"."message_reactions_v2" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "idx_chat_msg_v2_conversation" ON "chat"."messages_v2" USING btree ("conversation_did");--> statement-breakpoint
CREATE INDEX "idx_chat_msg_v2_from" ON "chat"."messages_v2" USING btree ("from_did");--> statement-breakpoint
CREATE INDEX "idx_chat_msg_v2_created" ON "chat"."messages_v2" USING btree ("created_at");