CREATE SCHEMA "market";
--> statement-breakpoint
CREATE TABLE "market"."disputes" (
	"id" text PRIMARY KEY NOT NULL,
	"listing_id" text NOT NULL,
	"transaction_id" text NOT NULL,
	"buyer_did" text NOT NULL,
	"seller_did" text NOT NULL,
	"type" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"resolution" text,
	"buyer_evidence" jsonb DEFAULT '[]'::jsonb,
	"seller_evidence" jsonb DEFAULT '[]'::jsonb,
	"evidence_deadline" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "market"."listings" (
	"id" text PRIMARY KEY NOT NULL,
	"seller_did" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"price" integer NOT NULL,
	"currency" text DEFAULT 'CAD',
	"category" text,
	"images" jsonb DEFAULT '[]'::jsonb,
	"quantity" integer DEFAULT 1,
	"status" text DEFAULT 'active',
	"seller_tier" text DEFAULT 'public_offplatform' NOT NULL,
	"contact_info" jsonb,
	"trust_threshold" jsonb,
	"range_km" integer DEFAULT 50,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"fair_manifest" jsonb,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "market"."disputes" ADD CONSTRAINT "disputes_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "market"."listings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_market_listings_seller_did" ON "market"."listings" USING btree ("seller_did");--> statement-breakpoint
CREATE INDEX "idx_market_listings_category_status" ON "market"."listings" USING btree ("category","status");--> statement-breakpoint
CREATE INDEX "idx_market_listings_status_created" ON "market"."listings" USING btree ("status","created_at");