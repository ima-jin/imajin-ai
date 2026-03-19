CREATE TABLE "pay"."connected_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"did" text NOT NULL,
	"stripe_account_id" text NOT NULL,
	"charges_enabled" boolean DEFAULT false NOT NULL,
	"payouts_enabled" boolean DEFAULT false NOT NULL,
	"details_submitted" boolean DEFAULT false NOT NULL,
	"onboarding_complete" boolean DEFAULT false NOT NULL,
	"currently_due" jsonb DEFAULT '[]'::jsonb,
	"eventually_due" jsonb DEFAULT '[]'::jsonb,
	"default_currency" text DEFAULT 'CAD',
	"platform_fee_bps" integer,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "connected_accounts_did_unique" UNIQUE("did"),
	CONSTRAINT "connected_accounts_stripe_account_id_unique" UNIQUE("stripe_account_id")
);
--> statement-breakpoint
DROP INDEX "pay"."idx_transactions_created";--> statement-breakpoint
DROP INDEX "pay"."idx_transactions_from_did";--> statement-breakpoint
DROP INDEX "pay"."idx_transactions_service";--> statement-breakpoint
DROP INDEX "pay"."idx_transactions_status";--> statement-breakpoint
DROP INDEX "pay"."idx_transactions_to_did";--> statement-breakpoint
ALTER TABLE "pay"."balance_rollups" DROP CONSTRAINT "balance_rollups_pkey";--> statement-breakpoint
ALTER TABLE "pay"."balance_rollups" ADD CONSTRAINT "balance_rollups_did_date_service_pk" PRIMARY KEY("did","date","service");--> statement-breakpoint
CREATE INDEX "idx_connected_accounts_did" ON "pay"."connected_accounts" USING btree ("did");--> statement-breakpoint
CREATE INDEX "idx_connected_accounts_stripe" ON "pay"."connected_accounts" USING btree ("stripe_account_id");--> statement-breakpoint
CREATE INDEX "idx_transactions_stripe_id" ON "pay"."transactions" USING btree ("stripe_id");--> statement-breakpoint
CREATE INDEX "idx_balance_rollups_did" ON "pay"."balance_rollups" USING btree ("did");--> statement-breakpoint
CREATE INDEX "idx_balance_rollups_date" ON "pay"."balance_rollups" USING btree ("date");--> statement-breakpoint
CREATE INDEX "idx_transactions_created" ON "pay"."transactions" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_transactions_from_did" ON "pay"."transactions" USING btree ("from_did");--> statement-breakpoint
CREATE INDEX "idx_transactions_service" ON "pay"."transactions" USING btree ("service");--> statement-breakpoint
CREATE INDEX "idx_transactions_status" ON "pay"."transactions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_transactions_to_did" ON "pay"."transactions" USING btree ("to_did");