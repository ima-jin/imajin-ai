CREATE TABLE "conversations" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"name" text,
	"description" text,
	"avatar" text,
	"visibility" text DEFAULT 'private' NOT NULL,
	"trust_radius" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	"last_message_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "invites" (
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
CREATE TABLE "messages" (
	"id" text PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"from_did" text NOT NULL,
	"content" jsonb NOT NULL,
	"content_type" text DEFAULT 'text' NOT NULL,
	"reply_to" text,
	"created_at" timestamp with time zone DEFAULT now(),
	"edited_at" timestamp with time zone,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "participants" (
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
CREATE TABLE "pre_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"did" text NOT NULL,
	"key" text NOT NULL,
	"used" boolean DEFAULT false,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "public_keys" (
	"did" text PRIMARY KEY NOT NULL,
	"identity_key" text NOT NULL,
	"signed_pre_key" text NOT NULL,
	"signature" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "read_receipts" (
	"conversation_id" text NOT NULL,
	"did" text NOT NULL,
	"last_read_message_id" text,
	"read_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "read_receipts_conversation_id_did_pk" PRIMARY KEY("conversation_id","did")
);
--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participants" ADD CONSTRAINT "participants_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pre_keys" ADD CONSTRAINT "pre_keys_did_public_keys_did_fk" FOREIGN KEY ("did") REFERENCES "public"."public_keys"("did") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "read_receipts" ADD CONSTRAINT "read_receipts_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "read_receipts" ADD CONSTRAINT "read_receipts_last_read_message_id_messages_id_fk" FOREIGN KEY ("last_read_message_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_conversations_type" ON "conversations" USING btree ("type");--> statement-breakpoint
CREATE INDEX "idx_conversations_created_by" ON "conversations" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "idx_invites_conversation" ON "invites" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "idx_invites_for_did" ON "invites" USING btree ("for_did");--> statement-breakpoint
CREATE INDEX "idx_messages_conversation" ON "messages" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "idx_messages_created" ON "messages" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_messages_from" ON "messages" USING btree ("from_did");--> statement-breakpoint
CREATE INDEX "idx_participants_did" ON "participants" USING btree ("did");--> statement-breakpoint
CREATE INDEX "idx_participants_role" ON "participants" USING btree ("role");--> statement-breakpoint
CREATE INDEX "idx_pre_keys_did" ON "pre_keys" USING btree ("did");