CREATE SCHEMA "coffee";
--> statement-breakpoint
CREATE TABLE "coffee"."pages" (
	"id" text PRIMARY KEY NOT NULL,
	"did" text NOT NULL,
	"handle" text NOT NULL,
	"title" text NOT NULL,
	"bio" text,
	"avatar" text,
	"avatar_asset_id" text,
	"theme" jsonb DEFAULT '{}'::jsonb,
	"payment_methods" jsonb NOT NULL,
	"presets" integer[] DEFAULT '{100,500,1000}',
	"fund_directions" jsonb DEFAULT '[]'::jsonb,
	"thank_you_content" text,
	"allow_custom_amount" boolean DEFAULT true,
	"allow_messages" boolean DEFAULT true,
	"is_public" boolean DEFAULT true,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "pages_did_unique" UNIQUE("did"),
	CONSTRAINT "pages_handle_unique" UNIQUE("handle")
);
--> statement-breakpoint
CREATE TABLE "coffee"."tips" (
	"id" text PRIMARY KEY NOT NULL,
	"page_id" text NOT NULL,
	"from_did" text,
	"from_name" text,
	"amount" integer NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"message" text,
	"fund_direction" text,
	"payment_method" text NOT NULL,
	"payment_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "coffee"."tips" ADD CONSTRAINT "tips_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "coffee"."pages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_coffee_pages_handle" ON "coffee"."pages" USING btree ("handle");--> statement-breakpoint
CREATE INDEX "idx_coffee_pages_did" ON "coffee"."pages" USING btree ("did");--> statement-breakpoint
CREATE INDEX "idx_tips_page" ON "coffee"."tips" USING btree ("page_id");--> statement-breakpoint
CREATE INDEX "idx_tips_status" ON "coffee"."tips" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_tips_created" ON "coffee"."tips" USING btree ("created_at");