CREATE SCHEMA "profile";
--> statement-breakpoint
CREATE TABLE "profile"."connection_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"from_did" text NOT NULL,
	"to_did" text NOT NULL,
	"message" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"responded_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "profile"."connections" (
	"id" text PRIMARY KEY NOT NULL,
	"from_did" text NOT NULL,
	"to_did" text NOT NULL,
	"trust_level" real DEFAULT 0 NOT NULL,
	"source" text NOT NULL,
	"source_id" text,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "profile"."did_migrations" (
	"id" text PRIMARY KEY NOT NULL,
	"old_did" text NOT NULL,
	"new_did" text NOT NULL,
	"migrated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "profile"."follows" (
	"id" text PRIMARY KEY NOT NULL,
	"follower_did" text NOT NULL,
	"followed_did" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "profile"."profiles" (
	"did" text PRIMARY KEY NOT NULL,
	"handle" text,
	"display_name" text NOT NULL,
	"display_type" text NOT NULL,
	"avatar" text,
	"avatar_asset_id" text,
	"bio" text,
	"contact_email" text,
	"phone" text,
	"visibility" text DEFAULT 'public' NOT NULL,
	"next_invite_available_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"last_seen_at" timestamp with time zone,
	"inference_enabled" boolean DEFAULT false NOT NULL,
	"show_market_items" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "profiles_handle_unique" UNIQUE("handle")
);
--> statement-breakpoint
CREATE TABLE "profile"."query_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"requester_did" text NOT NULL,
	"target_did" text NOT NULL,
	"model" text NOT NULL,
	"prompt_tokens" integer DEFAULT 0 NOT NULL,
	"completion_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" text DEFAULT '0' NOT NULL,
	"settled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX "idx_conn_requests_from" ON "profile"."connection_requests" USING btree ("from_did");--> statement-breakpoint
CREATE INDEX "idx_conn_requests_to" ON "profile"."connection_requests" USING btree ("to_did");--> statement-breakpoint
CREATE INDEX "idx_conn_requests_status" ON "profile"."connection_requests" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_connections_from" ON "profile"."connections" USING btree ("from_did");--> statement-breakpoint
CREATE INDEX "idx_connections_to" ON "profile"."connections" USING btree ("to_did");--> statement-breakpoint
CREATE INDEX "idx_connections_source" ON "profile"."connections" USING btree ("source","source_id");--> statement-breakpoint
CREATE INDEX "idx_did_migrations_old" ON "profile"."did_migrations" USING btree ("old_did");--> statement-breakpoint
CREATE INDEX "idx_did_migrations_new" ON "profile"."did_migrations" USING btree ("new_did");--> statement-breakpoint
CREATE INDEX "idx_follows_follower" ON "profile"."follows" USING btree ("follower_did");--> statement-breakpoint
CREATE INDEX "idx_follows_followed" ON "profile"."follows" USING btree ("followed_did");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_follows_unique" ON "profile"."follows" USING btree ("follower_did","followed_did");--> statement-breakpoint
CREATE INDEX "idx_profiles_handle" ON "profile"."profiles" USING btree ("handle");--> statement-breakpoint
CREATE INDEX "idx_profiles_display_type" ON "profile"."profiles" USING btree ("display_type");--> statement-breakpoint
CREATE INDEX "idx_query_logs_requester" ON "profile"."query_logs" USING btree ("requester_did");--> statement-breakpoint
CREATE INDEX "idx_query_logs_target" ON "profile"."query_logs" USING btree ("target_did");