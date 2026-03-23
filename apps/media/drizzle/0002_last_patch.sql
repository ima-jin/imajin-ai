CREATE TABLE "media"."asset_references" (
	"id" text PRIMARY KEY NOT NULL,
	"asset_id" text NOT NULL,
	"service" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "uq_asset_reference" UNIQUE("asset_id","service","entity_type","entity_id")
);
--> statement-breakpoint
ALTER TABLE "media"."asset_references" ADD CONSTRAINT "asset_references_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "media"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_asset_refs_asset" ON "media"."asset_references" USING btree ("asset_id");--> statement-breakpoint
CREATE INDEX "idx_asset_refs_service" ON "media"."asset_references" USING btree ("service");