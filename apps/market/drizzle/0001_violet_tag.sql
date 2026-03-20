CREATE TABLE "market"."seller_settings" (
	"did" text PRIMARY KEY NOT NULL,
	"show_market_items" boolean DEFAULT false,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
