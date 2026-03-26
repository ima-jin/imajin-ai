CREATE TABLE "relay"."relay_operation_log" (
	"seq" bigserial PRIMARY KEY NOT NULL,
	"cid" text NOT NULL,
	"jws_token" text NOT NULL,
	"kind" text NOT NULL,
	"chain_id" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "relay"."relay_content_chains" ADD COLUMN IF NOT EXISTS "last_created_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "relay"."relay_identity_chains" ADD COLUMN IF NOT EXISTS "head_cid" text;--> statement-breakpoint
ALTER TABLE "relay"."relay_identity_chains" ADD COLUMN IF NOT EXISTS "last_created_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "idx_relay_operation_log_cid" ON "relay"."relay_operation_log" USING btree ("cid");