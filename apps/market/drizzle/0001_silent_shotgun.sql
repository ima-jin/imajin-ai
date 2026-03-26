ALTER TABLE "market"."listings" ADD COLUMN IF NOT EXISTS "type" text DEFAULT 'sale' NOT NULL;--> statement-breakpoint
ALTER TABLE "market"."listings" ADD COLUMN IF NOT EXISTS "show_contact_info" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "market"."listings" ADD COLUMN IF NOT EXISTS "expires_at" timestamp with time zone;