ALTER TABLE "media"."asset_folders" DROP CONSTRAINT "asset_folders_asset_id_fkey";
--> statement-breakpoint
ALTER TABLE "media"."asset_folders" DROP CONSTRAINT "asset_folders_folder_id_fkey";
--> statement-breakpoint
DROP INDEX "media"."idx_assets_created";--> statement-breakpoint
DROP INDEX "media"."idx_assets_folder";--> statement-breakpoint
DROP INDEX "media"."idx_assets_mime";--> statement-breakpoint
DROP INDEX "media"."idx_assets_owner";--> statement-breakpoint
DROP INDEX "media"."idx_assets_status";--> statement-breakpoint
DROP INDEX "media"."idx_folders_owner";--> statement-breakpoint
DROP INDEX "media"."idx_folders_parent";--> statement-breakpoint
DROP INDEX "media"."idx_asset_folders_asset";--> statement-breakpoint
DROP INDEX "media"."idx_asset_folders_folder";--> statement-breakpoint
ALTER TABLE "media"."asset_folders" DROP CONSTRAINT "asset_folders_pkey";--> statement-breakpoint
ALTER TABLE "media"."asset_folders" ADD CONSTRAINT "asset_folders_asset_id_folder_id_pk" PRIMARY KEY("asset_id","folder_id");--> statement-breakpoint
ALTER TABLE "media"."asset_folders" ADD CONSTRAINT "asset_folders_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "media"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media"."asset_folders" ADD CONSTRAINT "asset_folders_folder_id_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "media"."folders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_assets_created" ON "media"."assets" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_assets_folder" ON "media"."assets" USING btree ("folder_id");--> statement-breakpoint
CREATE INDEX "idx_assets_mime" ON "media"."assets" USING btree ("mime_type");--> statement-breakpoint
CREATE INDEX "idx_assets_owner" ON "media"."assets" USING btree ("owner_did");--> statement-breakpoint
CREATE INDEX "idx_assets_status" ON "media"."assets" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_folders_owner" ON "media"."folders" USING btree ("owner_did");--> statement-breakpoint
CREATE INDEX "idx_folders_parent" ON "media"."folders" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "idx_asset_folders_asset" ON "media"."asset_folders" USING btree ("asset_id");--> statement-breakpoint
CREATE INDEX "idx_asset_folders_folder" ON "media"."asset_folders" USING btree ("folder_id");