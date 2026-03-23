CREATE SCHEMA "pay";
--> statement-breakpoint
CREATE TABLE "pay"."balance_rollups" (
	"did" text NOT NULL,
	"date" timestamp with time zone NOT NULL,
	"service" text NOT NULL,
	"earned" numeric(20, 8) DEFAULT '0',
	"spent" numeric(20, 8) DEFAULT '0',
	"tx_count" integer DEFAULT 0,
	CONSTRAINT "balance_rollups_did_date_service_pk" PRIMARY KEY("did","date","service")
);
--> statement-breakpoint
CREATE TABLE "pay"."balances" (
	"did" text PRIMARY KEY NOT NULL,
	"cash_amount" numeric(20, 8) DEFAULT '0' NOT NULL,
	"credit_amount" numeric(20, 8) DEFAULT '0' NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
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
CREATE TABLE "pay"."transactions" (
	"id" text PRIMARY KEY NOT NULL,
	"service" text NOT NULL,
	"type" text NOT NULL,
	"from_did" text,
	"to_did" text NOT NULL,
	"amount" numeric(20, 8) NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"source" text DEFAULT 'fiat' NOT NULL,
	"stripe_id" text,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"fair_manifest" jsonb,
	"batch_id" text,
	"credential_issued" boolean DEFAULT false,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX "idx_balance_rollups_did" ON "pay"."balance_rollups" USING btree ("did");--> statement-breakpoint
CREATE INDEX "idx_balance_rollups_date" ON "pay"."balance_rollups" USING btree ("date");--> statement-breakpoint
CREATE INDEX "idx_connected_accounts_did" ON "pay"."connected_accounts" USING btree ("did");--> statement-breakpoint
CREATE INDEX "idx_connected_accounts_stripe" ON "pay"."connected_accounts" USING btree ("stripe_account_id");--> statement-breakpoint
CREATE INDEX "idx_transactions_from_did" ON "pay"."transactions" USING btree ("from_did");--> statement-breakpoint
CREATE INDEX "idx_transactions_to_did" ON "pay"."transactions" USING btree ("to_did");--> statement-breakpoint
CREATE INDEX "idx_transactions_service" ON "pay"."transactions" USING btree ("service");--> statement-breakpoint
CREATE INDEX "idx_transactions_status" ON "pay"."transactions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_transactions_created" ON "pay"."transactions" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_transactions_stripe_id" ON "pay"."transactions" USING btree ("stripe_id");