CREATE SCHEMA IF NOT EXISTS "notify";
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "notify"."notifications" (
	"id" text PRIMARY KEY NOT NULL,
	"recipient_did" text NOT NULL,
	"sender_did" text,
	"scope" text NOT NULL,
	"urgency" text DEFAULT 'normal' NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"data" jsonb DEFAULT '{}'::jsonb,
	"channels_sent" text[] DEFAULT '{}',
	"read" boolean DEFAULT false,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "notify"."preferences" (
	"id" text PRIMARY KEY NOT NULL,
	"did" text NOT NULL,
	"scope" text NOT NULL,
	"email" boolean DEFAULT true,
	"inapp" boolean DEFAULT true
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_notifications_recipient" ON "notify"."notifications" USING btree ("recipient_did","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_notifications_unread" ON "notify"."notifications" USING btree ("recipient_did");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_preferences_did_scope" ON "notify"."preferences" USING btree ("did","scope");