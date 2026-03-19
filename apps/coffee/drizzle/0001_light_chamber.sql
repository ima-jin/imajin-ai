ALTER TABLE "coffee"."pages" DROP CONSTRAINT "coffee_pages_did_key";--> statement-breakpoint
ALTER TABLE "coffee"."pages" DROP CONSTRAINT "coffee_pages_handle_key";--> statement-breakpoint
ALTER TABLE "coffee"."tips" DROP CONSTRAINT "tips_page_id_fkey";
--> statement-breakpoint
DROP INDEX "coffee"."idx_coffee_pages_did";--> statement-breakpoint
DROP INDEX "coffee"."idx_coffee_pages_handle";--> statement-breakpoint
DROP INDEX "coffee"."idx_tips_created";--> statement-breakpoint
DROP INDEX "coffee"."idx_tips_page";--> statement-breakpoint
DROP INDEX "coffee"."idx_tips_status";--> statement-breakpoint
ALTER TABLE "coffee"."pages" ALTER COLUMN "payment_methods" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "coffee"."tips" ADD CONSTRAINT "tips_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "coffee"."pages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_coffee_pages_did" ON "coffee"."pages" USING btree ("did");--> statement-breakpoint
CREATE INDEX "idx_coffee_pages_handle" ON "coffee"."pages" USING btree ("handle");--> statement-breakpoint
CREATE INDEX "idx_tips_created" ON "coffee"."tips" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_tips_page" ON "coffee"."tips" USING btree ("page_id");--> statement-breakpoint
CREATE INDEX "idx_tips_status" ON "coffee"."tips" USING btree ("status");--> statement-breakpoint
ALTER TABLE "coffee"."pages" ADD CONSTRAINT "pages_did_unique" UNIQUE("did");--> statement-breakpoint
ALTER TABLE "coffee"."pages" ADD CONSTRAINT "pages_handle_unique" UNIQUE("handle");