CREATE SCHEMA "links";
--> statement-breakpoint
CREATE TABLE "links"."clicks" (
	"id" text PRIMARY KEY NOT NULL,
	"link_id" text NOT NULL,
	"clicked_at" timestamp with time zone DEFAULT now(),
	"referrer" text,
	"country" text
);
--> statement-breakpoint
CREATE TABLE "links"."pages" (
	"id" text PRIMARY KEY NOT NULL,
	"did" text NOT NULL,
	"handle" text NOT NULL,
	"title" text NOT NULL,
	"bio" text,
	"avatar" text,
	"avatar_asset_id" text,
	"theme" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"social_links" jsonb DEFAULT '{}'::jsonb,
	"is_public" boolean DEFAULT true,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "pages_did_unique" UNIQUE("did"),
	CONSTRAINT "pages_handle_unique" UNIQUE("handle")
);
--> statement-breakpoint
CREATE TABLE "links"."links" (
	"id" text PRIMARY KEY NOT NULL,
	"page_id" text NOT NULL,
	"title" text NOT NULL,
	"url" text NOT NULL,
	"icon" text,
	"thumbnail" text,
	"position" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true,
	"visibility" text DEFAULT 'public' NOT NULL,
	"clicks" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "links"."clicks" ADD CONSTRAINT "clicks_link_id_links_id_fk" FOREIGN KEY ("link_id") REFERENCES "links"."links"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "links"."links" ADD CONSTRAINT "links_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "links"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_link_clicks_link" ON "links"."clicks" USING btree ("link_id");--> statement-breakpoint
CREATE INDEX "idx_link_clicks_date" ON "links"."clicks" USING btree ("clicked_at");--> statement-breakpoint
CREATE INDEX "idx_link_pages_handle" ON "links"."pages" USING btree ("handle");--> statement-breakpoint
CREATE INDEX "idx_link_pages_did" ON "links"."pages" USING btree ("did");--> statement-breakpoint
CREATE INDEX "idx_links_page" ON "links"."links" USING btree ("page_id");--> statement-breakpoint
CREATE INDEX "idx_links_position" ON "links"."links" USING btree ("page_id","position");