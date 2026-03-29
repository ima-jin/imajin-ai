ALTER TABLE "profile"."profiles" DROP COLUMN "inference_enabled";--> statement-breakpoint
ALTER TABLE "profile"."profiles" DROP COLUMN "show_market_items";--> statement-breakpoint
ALTER TABLE "profile"."profiles" ADD COLUMN "feature_toggles" jsonb DEFAULT '{}'::jsonb NOT NULL;
