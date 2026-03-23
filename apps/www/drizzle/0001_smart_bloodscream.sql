DROP INDEX "www"."idx_www_contacts_email";--> statement-breakpoint
DROP INDEX "www"."idx_www_mailing_lists_slug";--> statement-breakpoint
DROP INDEX "www"."idx_www_subscriptions_contact";--> statement-breakpoint
DROP INDEX "www"."idx_www_subscriptions_list";--> statement-breakpoint
DROP INDEX "www"."idx_bug_reports_reporter";--> statement-breakpoint
DROP INDEX "www"."idx_bug_reports_status";--> statement-breakpoint
CREATE INDEX "idx_www_contacts_email" ON "www"."contacts" USING btree ("email");--> statement-breakpoint
CREATE INDEX "idx_www_mailing_lists_slug" ON "www"."mailing_lists" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "idx_www_subscriptions_contact" ON "www"."subscriptions" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "idx_www_subscriptions_list" ON "www"."subscriptions" USING btree ("mailing_list_id");--> statement-breakpoint
CREATE INDEX "idx_bug_reports_reporter" ON "www"."bug_reports" USING btree ("reporter_did");--> statement-breakpoint
CREATE INDEX "idx_bug_reports_status" ON "www"."bug_reports" USING btree ("status");