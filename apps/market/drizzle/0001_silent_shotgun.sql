ALTER TABLE "market"."listings" ADD COLUMN "type" text DEFAULT 'sale' NOT NULL;--> statement-breakpoint
ALTER TABLE "market"."listings" ADD COLUMN "show_contact_info" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "market"."listings" ADD COLUMN "expires_at" timestamp with time zone;