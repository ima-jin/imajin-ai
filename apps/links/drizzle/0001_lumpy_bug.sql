ALTER TABLE "links"."pages" DROP CONSTRAINT "link_pages_did_key";--> statement-breakpoint
ALTER TABLE "links"."pages" DROP CONSTRAINT "link_pages_handle_key";--> statement-breakpoint
ALTER TABLE "links"."clicks" DROP CONSTRAINT "link_clicks_link_id_fkey";
--> statement-breakpoint
ALTER TABLE "links"."links" DROP CONSTRAINT "links_page_id_fkey";
--> statement-breakpoint
DROP INDEX "links"."idx_link_pages_did";--> statement-breakpoint
DROP INDEX "links"."idx_link_pages_handle";--> statement-breakpoint
DROP INDEX "links"."idx_link_clicks_date";--> statement-breakpoint
DROP INDEX "links"."idx_link_clicks_link";--> statement-breakpoint
DROP INDEX "links"."idx_links_page";--> statement-breakpoint
DROP INDEX "links"."idx_links_position";--> statement-breakpoint
ALTER TABLE "links"."clicks" ADD CONSTRAINT "clicks_link_id_links_id_fk" FOREIGN KEY ("link_id") REFERENCES "links"."links"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "links"."links" ADD CONSTRAINT "links_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "links"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_link_pages_did" ON "links"."pages" USING btree ("did");--> statement-breakpoint
CREATE INDEX "idx_link_pages_handle" ON "links"."pages" USING btree ("handle");--> statement-breakpoint
CREATE INDEX "idx_link_clicks_date" ON "links"."clicks" USING btree ("clicked_at");--> statement-breakpoint
CREATE INDEX "idx_link_clicks_link" ON "links"."clicks" USING btree ("link_id");--> statement-breakpoint
CREATE INDEX "idx_links_page" ON "links"."links" USING btree ("page_id");--> statement-breakpoint
CREATE INDEX "idx_links_position" ON "links"."links" USING btree ("page_id","position");--> statement-breakpoint
ALTER TABLE "links"."pages" ADD CONSTRAINT "pages_did_unique" UNIQUE("did");--> statement-breakpoint
ALTER TABLE "links"."pages" ADD CONSTRAINT "pages_handle_unique" UNIQUE("handle");