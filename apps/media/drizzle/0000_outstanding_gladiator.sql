CREATE SCHEMA "media";
--> statement-breakpoint
CREATE TABLE "media"."asset_folders" (
	"asset_id" text NOT NULL,
	"folder_id" text NOT NULL,
	CONSTRAINT "asset_folders_asset_id_folder_id_pk" PRIMARY KEY("asset_id","folder_id")
);
--> statement-breakpoint
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
CREATE TABLE "media"."assets" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_did" text NOT NULL,
	"filename" text NOT NULL,
	"mime_type" text NOT NULL,
	"size" integer NOT NULL,
	"storage_path" text NOT NULL,
	"hash" text NOT NULL,
	"fair_manifest" jsonb DEFAULT '{}'::jsonb,
	"fair_path" text,
	"folder_id" text,
	"tags" jsonb DEFAULT '[]'::jsonb,
	"classification" text,
	"classification_confidence" integer,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "media"."folders" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_did" text NOT NULL,
	"name" text NOT NULL,
	"parent_id" text,
	"icon" text,
	"is_system" boolean DEFAULT false,
	"sort_order" integer DEFAULT 0,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "media"."asset_folders" ADD CONSTRAINT "asset_folders_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "media"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media"."asset_folders" ADD CONSTRAINT "asset_folders_folder_id_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "media"."folders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media"."asset_references" ADD CONSTRAINT "asset_references_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "media"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_asset_folders_asset" ON "media"."asset_folders" USING btree ("asset_id");--> statement-breakpoint
CREATE INDEX "idx_asset_folders_folder" ON "media"."asset_folders" USING btree ("folder_id");--> statement-breakpoint
CREATE INDEX "idx_asset_refs_asset" ON "media"."asset_references" USING btree ("asset_id");--> statement-breakpoint
CREATE INDEX "idx_asset_refs_service" ON "media"."asset_references" USING btree ("service");--> statement-breakpoint
CREATE INDEX "idx_assets_owner" ON "media"."assets" USING btree ("owner_did");--> statement-breakpoint
CREATE INDEX "idx_assets_status" ON "media"."assets" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_assets_mime" ON "media"."assets" USING btree ("mime_type");--> statement-breakpoint
CREATE INDEX "idx_assets_folder" ON "media"."assets" USING btree ("folder_id");--> statement-breakpoint
CREATE INDEX "idx_assets_created" ON "media"."assets" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_folders_owner" ON "media"."folders" USING btree ("owner_did");--> statement-breakpoint
CREATE INDEX "idx_folders_parent" ON "media"."folders" USING btree ("parent_id");